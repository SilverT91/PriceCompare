// Product parameters (src/core/params.ts). Texts are the shops' own, seen on 2026-11-28: ABCOM and
// Mironet titles, NAY's named values and description, TPD's and Datacomp's descriptions.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capacityGb, groupParams, offerParams, paramsFromProperties, paramsFromText, sameKey, type Params } from '../src/core/params.ts';
import { extractOffersFromBlocks } from '../src/core/jsonld.ts';

/** { key: value } of a parameter set, for short assertions. */
const values = (p: Params) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v?.value]));

describe('amounts', () => {
  test('capacities in GB, with thousands separators only where they make a usual size', () => {
    assert.equal(capacityGb('16 384 MB'), 16);
    assert.equal(capacityGb('64,00 GB'), 64);
    assert.equal(capacityGb('2 048  GB'), 2048);
    assert.equal(capacityGb('2TB SSD'), 2000);
    assert.equal(capacityGb('512SSD'), 512);
    assert.equal(capacityGb('Apple iPhone 16 128GB'), 128);
    assert.equal(capacityGb('RTX 5080'), null);
  });
});

describe('titles', () => {
  test('a computer with its configuration in the title (ABCOM)', () => {
    assert.deepEqual(values(paramsFromText('HP PC Z2 Tower G1i 700W, Intel Core U9 285K vPro, RTX Pro 4000Bl 24GB,2×16GB DDR5,1TB,WiFi 7+BT,no Kb+mouse,Win11Pro,3yo', 'title')), {
      psu_w: 700, cpu: 'Intel Core U9 285K vPro', gpu: 'RTX Pro 4000Bl', vram_gb: 24, ram_gb: 32, storage_gb: 1000, os: 'Windows 11 Pro',
    });
    assert.deepEqual(values(paramsFromText('HP PC OMEN 45L GT22-3582nc, Ultra 9-285K, 64GB DDR5, 2TB SSD, RTX 5080 16GB,Win 11 Home,3-3-0, Game Pass', 'title')), {
      cpu: 'Ultra 9-285K', ram_gb: 64, storage_gb: 2000, gpu: 'RTX 5080', vram_gb: 16, os: 'Windows 11 Home',
    });
    const mini = values(paramsFromText('HP PC Z2 Mini G1a AMD Ryzen AI Max PRO 395 APU, 128GB fixed, 2TB, AMD Radeon 8060S graphics, no Kb+Mouse, 300W, Win11Pro, 3yo', 'title'));
    assert.equal(mini.cpu, 'AMD Ryzen AI Max PRO 395');
    assert.equal(mini.ram_gb, 128);
    assert.equal(mini.storage_gb, 2000);
    assert.equal(mini.gpu, 'AMD Radeon 8060S');
  });
  test('a laptop written with " / " (Mironet) and with " - " before the list', () => {
    assert.deepEqual(values(paramsFromText('Lenovo IdeaPad Slim 5 16AKP10 modrá / Notebook / 16" WUXGA / AMD Ryzen AI 5 330 / 16GB / 512GB SSD / W11H', 'title')), {
      screen_in: 16, cpu: 'AMD Ryzen AI 5 330', ram_gb: 16, storage_gb: 512, os: 'Windows 11 Home',
    });
    assert.deepEqual(values(paramsFromText('LENOVO NTB IdeaPad Slim 5 16IMH10 - Ultra 5 135H,16" WUXGA OLED,16GB,512SSD,Inte...', 'title')), {
      cpu: 'Ultra 5 135H', screen_in: 16, ram_gb: 16, storage_gb: 512,
    });
  });
  test('phones: one amount is the storage; "8GB/256GB" is memory and storage', () => {
    assert.deepEqual(values(paramsFromText('Apple iPhone 16 128GB Black (MYE73SX/A)', 'title')), { storage_gb: 128 });
    assert.deepEqual(values(paramsFromText('Samsung Galaxy S25 Ultra 12GB/256GB Titanium Black', 'title')), { ram_gb: 12, storage_gb: 256 });
    assert.deepEqual(values(paramsFromText('Mobilný telefón Samsung Galaxy A56 5G 8 GB / 256 GB čierny', 'title')), { ram_gb: 8, storage_gb: 256 });
  });
  test('a title without parameters gives none', () => {
    assert.deepEqual(paramsFromText('Oral-B Pro 3 3000 čierna', 'title'), {});
    assert.deepEqual(paramsFromText('HP Z2 Tower G1i, A40SRET', 'title'), {});
  });
});

describe('descriptions', () => {
  test('NAY: a bullet list; TPD: "label: value" pairs; Mironet and Datacomp: a short list', () => {
    assert.deepEqual(values(paramsFromText('stolný počítač • procesor Intel Core Ultra 9 285K (24-jadrový – až 5,5 GHz) • samostatná grafická karta NVIDIA® GeForce RTX™ 5080 (16 GB) • úložisko SSD 2 000 GB • pamäť RAM 64 GB • Wi-Fi 7, Bluetooth 5.4 • zdroj 1 000 W • operačný systém Windows 11 Home', 'description')), {
      cpu: 'Intel Core Ultra 9 285K', gpu: 'NVIDIA GeForce RTX 5080', vram_gb: 16, storage_gb: 2000, ram_gb: 64, psu_w: 1000, os: 'Windows 11 Home',
    });
    assert.deepEqual(values(paramsFromText('Operačný systém: Windows 11 Pro 64-bit &bull; Procesor: Intel Core Ultra 5 235 až 5 GHz &bull; Grafická karta: Intel &bull; Pamäť RAM: DDR5 16 GB &bull; Úložný priestor: SSD: 512 GB', 'description')), {
      os: 'Windows 11 Pro', cpu: 'Intel Core Ultra 5 235', ram_gb: 16, storage_gb: 512,
    });
    assert.deepEqual(values(paramsFromText('HP Z2 Mini G1i černá Pracovní stanice, Intel Core Ultra 5 245, 16GB, 512GB SSD, RTX A400 4GB, W11P', 'description')), {
      cpu: 'Intel Core Ultra 5 245', storage_gb: 512, gpu: 'RTX A400', vram_gb: 4, os: 'Windows 11 Pro', ram_gb: 16,
    });
    assert.deepEqual(values(paramsFromText(', mini počítač, multimediálny, 128 GB RAM, DDR5 (PC5), 1TB SSD, Wi-Fi 7, Bluetooth v5.4, bez mechaniky, Linux', 'description')), {
      ram_gb: 128, storage_gb: 1000, os: 'Linux',
    });
  });
});

describe('named values (JSON-LD additionalProperty)', () => {
  const nay = [
    ['Počet jadier', '24 '], ['Procesor', 'INTEL Core Ultra 9'], ['Označenie procesora', '285K'], ['Veľkosť pamäte RAM', '64,00 GB'],
    ['Typ úložiska', 'SSD  '], ['Kapacita úložiska', '2 048  GB'], ['Grafická karta', 'nezdieľaná pamäť'], ['Označenie grafickej karty', 'GeForce RTX™ 5080  '],
    ['Veľkosť pamäte VGA', '16 384 MB '], ['Požiadavka výkonu', '1000  W'], ['Operačný systém', 'Microsoft Windows 11 Home '], ['Kód výrobcu', 'D8QT8EA#BCM'],
  ].map(([name, value]) => ({ name, value }));
  test('NAY\'s values, with the processor put together from two of them', () => {
    assert.deepEqual(values(paramsFromProperties(nay)), {
      cpu: 'Intel Core Ultra 9 285K', ram_gb: 64, storage_gb: 2048, gpu: 'GeForce RTX 5080', vram_gb: 16, os: 'Windows 11 Home',
    });
  });
  test('a chipset is not the processor; a Polish label for the graphics chip is the graphics card', () => {
    const p = values(paramsFromProperties([{ name: 'Chipset', value: 'Intel W880' }, { name: 'Procesor graficzny', value: 'NVIDIA GeForce RTX 5060' }]));
    assert.equal(p.cpu, undefined);
    assert.equal(p.gpu, 'NVIDIA GeForce RTX 5060');
    assert.equal(values(paramsFromProperties([{ name: 'Čipset', value: 'Qualcomm Snapdragon 8 Elite' }])).cpu, 'Qualcomm Snapdragon 8 Elite');
  });
  test('read from a product page\'s JSON-LD: named values first, then the title', () => {
    const page = [{
      '@context': 'https://schema.org', '@type': 'Product', name: 'Herný počítač HP OMEN MAX by HP 45L GT22-3582nc čierny',
      description: 'stolný počítač • pamäť RAM 64 GB',
      additionalProperty: nay.map((x) => ({ '@type': 'PropertyValue', name: x.name, value: x.value })),
      offers: { '@type': 'Offer', price: '5739', priceCurrency: 'EUR' },
    }];
    const [offer] = extractOffersFromBlocks(page, 'https://www.nay.sk/x', 'nay_sk').offers;
    assert.equal(offer.params?.vram_gb?.value, 16);
    assert.equal(offer.params?.vram_gb?.source, 'properties');
    const merged = offerParams(offer.title, offer.params);
    assert.equal(merged.ram_gb?.source, 'properties');
  });
});

describe('a product\'s parameters from its offers', () => {
  test('one value written several ways is one value; a real difference is kept and shown', () => {
    assert.equal(sameKey('cpu', 'Ultra 9-285K'), sameKey('cpu', 'Intel Core Ultra 9 285K'));
    assert.equal(sameKey('gpu', 'RTX Pro 4000Bl'), sameKey('gpu', 'NVIDIA RTX PRO 4000 Blackwell'));
    assert.notEqual(sameKey('gpu', 'RTX 4000 Ada'), sameKey('gpu', 'RTX PRO 4000 Blackwell'));
    assert.equal(sameKey('storage_gb', 2048), sameKey('storage_gb', 2000));
    const g = groupParams([
      { shopName: 'NAY', params: { cpu: { value: 'Intel Core Ultra 9 285K', source: 'properties' }, ram_gb: { value: 64, source: 'properties' } } },
      { shopName: 'ABCOM Košice', params: { cpu: { value: 'Ultra 9-285K', source: 'title' }, ram_gb: { value: 32, source: 'title' } } },
      { shopName: 'Datacomp', params: {} },
    ]);
    assert.deepEqual(g.cpu, { value: 'Intel Core Ultra 9 285K', source: 'properties', shop: 'NAY', others: [] });
    assert.deepEqual(g.ram_gb?.others, [32]);
    assert.equal(g.vram_gb, undefined);
  });
});

describe('found in a live check (2026-11-28)', () => {
  test('a desktop\'s 3.5" drive bay is not a screen; a screen size needs a screen word', () => {
    assert.equal(paramsFromText('Rozširujúce pozície: 2× 3.5" interná, 1× 5,25" externá', 'description').screen_in, undefined);
    assert.equal(paramsFromText('displej 6,1" OLED, 120 Hz', 'description').screen_in?.value, 6.1);
  });
  test('NAY writes 24 GB of graphics memory as "24 576 MB"', () => {
    assert.equal(capacityGb('24 576 MB'), 24);
    assert.equal(values(paramsFromProperties([{ name: 'Veľkosť pamäte VGA', value: '24 576 MB' }])).vram_gb, 24);
  });
  test('a power requirement is not taken for the power supply', () => {
    assert.equal(values(paramsFromProperties([{ name: 'Požiadavka výkonu', value: '1000 W' }])).psu_w, undefined);
    assert.equal(values(paramsFromProperties([{ name: 'Zdroj', value: '1200 W' }])).psu_w, 1200);
  });
});
