/* =========================================================
   MOSTRADOR · arranque de la aplicación
   ========================================================= */
import { boot, registerView } from './js/core.js';
import { initSale, renderCart } from './js/sale.js';
import { initProducts, loadProductView } from './js/products.js';
import { initInventory, loadInventoryView } from './js/inventory.js';
import { initQuotes, loadQuotesView } from './js/quotes.js';
import { initSales, loadSalesView } from './js/sales.js';
import { initCustomers, loadCustomersView } from './js/customers.js';
import { initReports, loadReportsView } from './js/reports.js';
import { initConfig, loadConfigView } from './js/config.js';

initSale();
initProducts();
initInventory();
initQuotes();
initSales();
initCustomers();
initReports();
initConfig();

registerView('venta', async () => {
  renderCart();
});
registerView('productos', loadProductView);
registerView('inventario', loadInventoryView);
registerView('cotizaciones', loadQuotesView);
registerView('ventas', loadSalesView);
registerView('clientes', loadCustomersView);
registerView('reportes', loadReportsView);
registerView('config', loadConfigView);

boot().catch((err) => {
  console.error(err);
  const status = document.getElementById('statusMsg');
  if (status) status.textContent = `Error al iniciar: ${err.message}`;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-overlay" style="z-index:3000"><div class="modal small"><div class="modal-head"><span>No se pudo iniciar Mostrador</span></div>
      <div class="modal-body"><p>${String(err.message || err).replace(/[<>&]/g, '')}</p>
      <p class="mini-note">Verifica que el servidor esté ejecutándose con <b>npm start</b> y recarga la página.</p></div></div></div>`
  );
});
