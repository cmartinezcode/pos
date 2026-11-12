import {
  db,
  tx,
  getSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  buildSearchText,
  nowLocal
} from './db.js';

const UNITS = [
  ['Unidad', 'UND', 0],
  ['Caja', 'CAJA', 0],
  ['Metro', 'METRO', 2],
  ['Kilogramo', 'KG', 2],
  ['Libra', 'LIBRA', 2],
  ['Galón', 'GAL', 2],
  ['Par', 'PAR', 0]
];

const CATEGORIES = [
  ['Tornillería', null],
  ['Tornillos', 'Tornillería'],
  ['Tuercas', 'Tornillería'],
  ['Arandelas', 'Tornillería'],
  ['Chazos y tarugos', 'Tornillería'],
  ['Remaches', 'Tornillería'],
  ['Herramientas', null],
  ['Plomería', null],
  ['Pinturas', null],
  ['Eléctrico', null],
  ['Cerraduras', null],
  ['Adhesivos', null]
];

/* [sku, nombre, categoría, unidad, medida, material, marca, costo, precio, mayorista, stock, mínimo, ubicación, presentaciones] */
const PRODUCTS = [
  ['TOR-1420', 'Tornillo hex 1/4" x 2"', 'Tornillos', 'UND', '1/4" x 2"', 'Acero zincado', 'Genérico', 150, 250, 210, 480, 100, 'A1-01', [['Caja x 100', 100, 22000]]],
  ['TOR-1430', 'Tornillo hex 1/4" x 3"', 'Tornillos', 'UND', '1/4" x 3"', 'Acero zincado', 'Genérico', 180, 310, 260, 320, 80, 'A1-02', [['Caja x 100', 100, 27000]]],
  ['TOR-5162', 'Tornillo hex 5/16" x 2"', 'Tornillos', 'UND', '5/16" x 2"', 'Acero zincado', 'Genérico', 240, 400, 340, 260, 60, 'A1-03', []],
  ['TOR-3825', 'Tornillo hex 3/8" x 2-1/2"', 'Tornillos', 'UND', '3/8" x 2-1/2"', 'Acero zincado', 'Genérico', 380, 620, 540, 140, 30, 'A1-04', []],
  ['TOR-DW61', 'Tornillo drywall 6 x 1" punta fina', 'Tornillos', 'UND', '6 x 1"', 'Acero fosfatado', 'Genérico', 12, 35, 28, 4200, 1000, 'A2-01', [['Caja x 1000', 1000, 28000]]],
  ['TOR-DW82', 'Tornillo drywall 8 x 2"', 'Tornillos', 'UND', '8 x 2"', 'Acero fosfatado', 'Genérico', 22, 60, 50, 2800, 800, 'A2-02', [['Caja x 500', 500, 26000]]],
  ['TOR-MAD38', 'Tornillo madera 8 x 1-1/2"', 'Tornillos', 'UND', '8 x 1-1/2"', 'Acero', 'Genérico', 30, 80, 65, 950, 200, 'A2-03', []],
  ['TOR-TIR82', 'Tirafondo 8 x 2" cabeza hexagonal', 'Tornillos', 'UND', '8 x 2"', 'Acero', 'Genérico', 120, 350, 290, 380, 80, 'A2-04', []],
  ['TOR-AUT38', 'Tornillo autorroscante 8 x 3/4"', 'Tornillos', 'UND', '8 x 3/4"', 'Acero', 'Genérico', 18, 50, 42, 1600, 400, 'A2-05', []],

  ['TUE-14', 'Tuerca hex 1/4" galvanizada', 'Tuercas', 'UND', '1/4"', 'Acero galvanizado', 'Genérico', 35, 80, 65, 600, 150, 'B1-01', [['Caja x 100', 100, 7000]]],
  ['TUE-516', 'Tuerca hex 5/16"', 'Tuercas', 'UND', '5/16"', 'Acero galvanizado', 'Genérico', 55, 110, 90, 420, 100, 'B1-02', []],
  ['TUE-38', 'Tuerca hex 3/8"', 'Tuercas', 'UND', '3/8"', 'Acero galvanizado', 'Genérico', 90, 170, 140, 260, 60, 'B1-03', []],
  ['TUE-SEG14', 'Tuerca de seguridad 1/4" nylon', 'Tuercas', 'UND', '1/4"', 'Acero', 'Genérico', 60, 140, 115, 180, 40, 'B1-04', []],
  ['TUE-MAR14', 'Tuerca mariposa 1/4"', 'Tuercas', 'UND', '1/4"', 'Acero', 'Genérico', 80, 190, 160, 90, 20, 'B1-05', []],

  ['ARA-14', 'Arandela plana 1/4"', 'Arandelas', 'UND', '1/4"', 'Acero', 'Genérico', 8, 30, 24, 1800, 400, 'B2-01', [['Caja x 1000', 1000, 25000]]],
  ['ARA-516', 'Arandela plana 5/16"', 'Arandelas', 'UND', '5/16"', 'Acero', 'Genérico', 12, 40, 32, 1200, 300, 'B2-02', []],
  ['ARA-38', 'Arandela plana 3/8"', 'Arandelas', 'UND', '3/8"', 'Acero', 'Genérico', 18, 55, 45, 800, 200, 'B2-03', []],
  ['ARA-PRE14', 'Arandela de presión 1/4"', 'Arandelas', 'UND', '1/4"', 'Acero', 'Genérico', 10, 35, 28, 900, 200, 'B2-04', []],
  ['ARA-GRO14', 'Arandela grower 1/4"', 'Arandelas', 'UND', '1/4"', 'Acero', 'Genérico', 12, 38, 30, 700, 150, 'B2-05', []],

  ['CHA-6', 'Chazo plástico 6 mm con tornillo', 'Chazos y tarugos', 'UND', '6 mm', 'Plástico', 'Genérico', 8, 25, 20, 2500, 500, 'C1-01', [['Caja x 100', 100, 2000]]],
  ['CHA-8', 'Chazo plástico 8 mm con tornillo', 'Chazos y tarugos', 'UND', '8 mm', 'Plástico', 'Genérico', 12, 35, 28, 1800, 400, 'C1-02', [['Caja x 100', 100, 3000]]],
  ['CHA-10', 'Chazo plástico 10 mm con tornillo', 'Chazos y tarugos', 'UND', '10 mm', 'Plástico', 'Genérico', 18, 50, 40, 900, 200, 'C1-03', []],
  ['TAR-14', 'Tarugo expansivo 1/4"', 'Chazos y tarugos', 'UND', '1/4"', 'Zinc', 'Genérico', 250, 650, 550, 120, 25, 'C1-04', []],

  ['REM-18', 'Remache pop 1/8" x 1/4" aluminio', 'Remaches', 'UND', '1/8" x 1/4"', 'Aluminio', 'Genérico', 25, 60, 48, 1500, 300, 'C2-01', [['Caja x 100', 100, 5500]]],
  ['REM-532', 'Remache pop 5/32" x 3/8" acero', 'Remaches', 'UND', '5/32" x 3/8"', 'Acero', 'Genérico', 35, 90, 75, 150, 200, 'C2-02', [['Caja x 100', 100, 8000]]],

  ['HER-MAR16', 'Martillo de uña 16 oz mango fibra', 'Herramientas', 'UND', '', 'Acero', 'Total', 18000, 28000, 25000, 12, 3, 'D1-01', []],
  ['HER-DES6', 'Destornillador plano 6" mango bimaterial', 'Herramientas', 'UND', '6"', 'Acero', 'Total', 6500, 12000, 10500, 18, 4, 'D1-02', []],
  ['HER-ALI8', 'Alicate universal 8" acero cromo', 'Herramientas', 'UND', '8"', 'Acero cromo', 'Total', 14000, 22000, 19500, 10, 3, 'D1-03', []],
  ['HER-LLA10', 'Llave ajustable 10" cromada', 'Herramientas', 'UND', '10"', 'Acero', 'Total', 16000, 25000, 22000, 8, 2, 'D1-04', []],
  ['HER-CIN5', 'Cinta métrica 5 m carcasa ABS', 'Herramientas', 'UND', '5 m', 'Acero', 'Total', 9000, 15000, 13000, 15, 4, 'D1-05', []],
  ['HER-BRO14', 'Broca concreto 1/4" SDS', 'Herramientas', 'UND', '1/4"', 'Acero', 'Total', 3800, 6500, 5800, 40, 10, 'D2-01', []],
  ['HER-BRO516', 'Broca concreto 5/16" SDS', 'Herramientas', 'UND', '5/16"', 'Acero', 'Total', 4800, 8000, 7000, 35, 10, 'D2-02', []],
  ['HER-TAL12', 'Taladro percutor 1/2" 650 W', 'Herramientas', 'UND', '1/2"', 'Metal/plástico', 'Total', 145000, 189000, 175000, 3, 1, 'D2-03', []],

  ['PLO-TUB12', 'Tubo PVC presión 1/2" x 3 m', 'Plomería', 'UND', '1/2" x 3 m', 'PVC', 'Pavco', 4200, 6500, 6000, 30, 8, 'E1-01', []],
  ['PLO-COD12', 'Codo PVC 1/2" x 90°', 'Plomería', 'UND', '1/2"', 'PVC', 'Pavco', 700, 1200, 1000, 120, 30, 'E1-02', []],
  ['PLO-PEG250', 'Pegamento PVC 250 ml', 'Plomería', 'UND', '250 ml', 'PVC', 'Pavco', 12000, 18000, 16000, 4, 4, 'E1-03', []],
  ['PLO-CIN12', 'Cinta teflón 1/2" x 10 m', 'Plomería', 'UND', '1/2" x 10 m', 'PTFE', 'Genérico', 1200, 2500, 2200, 50, 12, 'E1-04', []],

  ['PIN-ESM14', 'Esmalte negro brillante 1/4 galón', 'Pinturas', 'UND', '1/4 galón', 'Esmalte', 'Pintuco', 15000, 22000, 20000, 11, 3, 'F1-01', []],
  ['PIN-BRO2', 'Brocha cerda natural 2"', 'Pinturas', 'UND', '2"', 'Cerda', 'Genérico', 3800, 6000, 5200, 4, 6, 'F1-02', []],
  ['PIN-ROD9', 'Rodillo felpa 9" con mango', 'Pinturas', 'UND', '9"', 'Felpa', 'Genérico', 7000, 11000, 9500, 9, 3, 'F1-03', []],

  ['ELE-CINAI', 'Cinta aislante 19 mm x 18 m', 'Eléctrico', 'UND', '19 mm x 18 m', 'PVC', '3M', 1800, 3500, 3000, 60, 15, 'G1-01', []],
  ['ELE-SIL', 'Silicón transparente 300 ml', 'Eléctrico', 'UND', '300 ml', 'Silicona', 'Genérico', 5500, 9000, 8000, 22, 6, 'G1-02', []],
  ['ELE-TOMDOB', 'Tomacorriente doble blanco', 'Eléctrico', 'UND', '', 'Plástico', 'Genérico', 4500, 7500, 6500, 35, 8, 'G1-03', []],

  ['CER-CAN40', 'Candado 40 mm latón', 'Cerraduras', 'UND', '40 mm', 'Latón', 'Genérico', 6500, 9500, 8500, 3, 5, 'H1-01', []],
  ['CER-BIS3', 'Bisagra 3" zincada', 'Cerraduras', 'UND', '3"', 'Acero', 'Genérico', 1500, 2500, 2200, 60, 12, 'H1-02', []],

  ['ADH-SUP', 'Superbonder 3 g', 'Adhesivos', 'UND', '3 g', 'Cianoacrilato', 'Loctite', 2800, 5000, 4500, 28, 8, 'I1-01', []],
  ['ADH-BAR', 'Pegamento en barra 21 g', 'Adhesivos', 'UND', '21 g', 'Adhesivo', 'Genérico', 2200, 4000, 3500, 40, 10, 'I1-02', []]
];

const CUSTOMERS = [
  ['900.456.123-1', 'Ferretería La 80', '310 555 0101', 'Cra 80 # 45-12', 'ventas@ferreteriala80.co'],
  ['900.789.456-2', 'Constructora Andina SAS', '320 444 2020', 'Calle 100 # 15-30', 'compras@andina.co'],
  ['', 'Juan Pérez', '300 123 4567', 'Barrio Kennedy', '']
];

function pad(n, width) {
  return String(n).padStart(width, '0');
}

export function seedDatabase() {
  const settings = getSettings();
  if (!db.prepare('SELECT COUNT(*) AS c FROM settings').get().c) {
    saveSettings({
      ...DEFAULT_SETTINGS,
      store_doc: '900.123.456-7',
      store_address: 'Calle 10 # 5-20',
      store_city: 'Bogotá',
      store_phone: '300 123 4567'
    });
  }

  const catIds = new Map();
  const unitIds = new Map();

  tx(() => {
    for (const [name, parent] of CATEGORIES) {
      let row = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(name);
      if (!row) {
        const parentId = parent ? catIds.get(parent) || null : null;
        const r = db
          .prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)')
          .run(name, parentId);
        row = { id: Number(r.lastInsertRowid) };
      }
      catIds.set(name, row.id);
    }

    for (const [name, abbr, decimals] of UNITS) {
      let row = db.prepare('SELECT id FROM units WHERE abbr = ? COLLATE NOCASE').get(abbr);
      if (!row) {
        const r = db
          .prepare('INSERT INTO units (name, abbr, decimals) VALUES (?, ?, ?)')
          .run(name, abbr, decimals);
        row = { id: Number(r.lastInsertRowid) };
      }
      unitIds.set(abbr, row.id);
    }

    if (!db.prepare('SELECT COUNT(*) AS c FROM customers').get().c) {
      const stmt = db.prepare(
        'INSERT INTO customers (doc, name, phone, address, email) VALUES (?, ?, ?, ?, ?)'
      );
      for (const c of CUSTOMERS) stmt.run(...c);
    }

    if (db.prepare('SELECT COUNT(*) AS c FROM products').get().c > 0) return;

    const today = nowLocal();
    const insert = db.prepare(`
      INSERT INTO products
        (sku, barcode, name, search_text, category_id, unit_id, measure, material, brand,
         cost_price, sale_price, wholesale_price, stock, min_stock, location, tax_rate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPres = db.prepare(
      'INSERT INTO presentations (product_id, label, qty, price, barcode, sort) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertMov = db.prepare(`
      INSERT INTO stock_movements (product_id, type, qty, stock_after, cost, note, created_at)
      VALUES (?, 'inicial', ?, ?, ?, 'Carga inicial de demostración', ?)
    `);

    PRODUCTS.forEach((p, i) => {
      const [sku, name, cat, unitAbbr, measure, material, brand, cost, price, wholesale, stock, minStock, location, presentations] = p;
      const categoryId = catIds.get(cat) || null;
      const unitId = unitIds.get(unitAbbr) || unitIds.get('UND');
      const barcode = `7701000${pad(i + 1, 6)}`;
      const search = buildSearchText(
        { name, sku, barcode, measure, material, brand, location },
        cat,
        unitAbbr
      );
      const r = insert.run(
        sku, barcode, name, search, categoryId, unitId, measure, material, brand,
        cost, price, wholesale, stock, minStock, location, settings.default_tax_rate ?? 19, today
      );
      const productId = Number(r.lastInsertRowid);
      insertMov.run(productId, stock, stock, cost, today);

      presentations.forEach((pres, j) => {
        const [label, qty, presPrice] = pres;
        insertPres.run(
          productId,
          label,
          qty,
          presPrice,
          `7702000${pad(i + 1, 4)}${pad(j + 1, 2)}`,
          j
        );
      });
    });
  });
}
