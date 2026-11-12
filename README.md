# Mostrador POS · 80 mm

POS de consola para ferretería/tornillería, rápido y sin dependencias externas.
Funciona en el navegador con estética de terminal, pero acepta ratón, teclado y
lector de código de barras. Imprime tickets internos de 80 mm (48 columnas,
CP437/ESC/POS). **No emite facturación electrónica DIAN.**

## Requisitos

- Linux (probado en escritorio con Node.js 26; requiere Node.js 22.5 o superior).
- Node.js con el módulo integrado `node:sqlite`.
- Opcional: impresora térmica USB de 80 mm o impresora de red.

No hay que instalar paquetes npm. Todo usa la biblioteca estándar de Node.

## Arranque

```bash
cd ~/mostrador
npm start
```

Abre `http://127.0.0.1:3000`. La primera ejecución crea la base de datos y carga
datos de demostración (categorías, unidades, productos, presentaciones y
clientes).

Para usarlo desde otro equipo de la red local:

```bash
HOST=0.0.0.0 npm start
```

Luego entra desde el otro equipo a `http://IP-DEL-SERVIDOR:3000`.

Variables disponibles:

- `PORT`: puerto HTTP (por defecto `3000`).
- `HOST`: interfaz de escucha (por defecto `127.0.0.1`).

## Impresión de 80 mm

Configura la impresora en **F10 · Configuración**. Hay tres métodos:

1. **USB directo (recomendado).** Escribe los bytes ESC/POS directo al dispositivo,
   por defecto `/dev/usb/lp0`. El usuario debe pertenecer al grupo `lp`:

   ```bash
   sudo usermod -aG lp $USER
   ```

   Cierra sesión y vuelve a entrar. Verifica el dispositivo con:

   ```bash
   ls -l /dev/usb/lp0
   ```

   Si tu impresora aparece con otro nombre, cámbialo en Configuración. Usa
   **Probar impresión** para validar.

2. **Navegador / CUPS.** Genera una vista previa y usa el diálogo de impresión del
   sistema. Sirve si ya tienes la impresora instalada en CUPS.

3. **Red TCP.** Imprime a una impresora Ethernet/WiFi en el puerto `9100`
   (configura IP y puerto).

El ticket se genera a 48 columnas. Si tu papel/impresora necesita otro ancho,
ajusta las columnas en Configuración. La opción **cortar papel** envía el comando
de corte al finalizar.

## Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `F1` | Ayuda |
| `F2` | Venta / mostrador |
| `F3` | Productos (en Productos abre uno nuevo) |
| `F4` | Cobrar el carrito o guardar cotización |
| `F5` | Inventario y kardex |
| `F6` | Historial de ventas |
| `F7` | Cotizaciones |
| `F8` | Clientes |
| `F9` | Reimprimir último ticket |
| `F10` | Configuración |
| `F11` | Reportes |
| `Enter` | Agregar resultado de búsqueda / abrir seleccionado |
| `↑` `↓` | Navegar resultados o filas |
| `Supr` | Quitar línea seleccionada del carrito |
| `Esc` | Cerrar búsqueda o modal |

En la búsqueda de venta puedes escribir `3 x tornillo` o `3 * tornillo` para
agregar tres unidades de una vez. Escanear un código y pulsar `Enter` agrega el
producto directamente.

## Módulos

- **Venta:** búsqueda por nombre, código interno, código de barras, medida,
  material, marca o categoría. Carrito editable (cantidad, precio, descuento),
  cliente, descuento global, pago en efectivo/tarjeta/transferencia/crédito,
  cálculo de cambio y ticket.
- **Productos:** categorías, unidades de medida con decimales, código interno
  automático, código de barras, medida/tamaño, material, marca, ubicación, costo,
  precio de venta, precio mayorista, IVA, stock mínimo y presentaciones/empaques
  (por ejemplo “Caja x 100”).
- **Inventario:** stock valorizado, alertas bajo mínimo, ajustes por entrada,
  salida o conteo físico, y kardex de movimientos.
- **Cotizaciones:** creación desde la venta, edición, estados (borrador, enviada,
  aceptada, vencida, anulada), impresión y conversión a venta descontando stock.
- **Clientes:** documento/NIT, teléfono, dirección, correo y notas.
- **Ventas:** consulta por fecha, detalle, reimpresión y anulación con devolución
  automática de inventario.
- **Reportes:** ventas, utilidad, ticket promedio, productos más vendidos, ventas
  por día, medios de pago y stock bajo.
- **Configuración:** datos del negocio, textos del ticket, impuestos, prefijos de
  numeración, impresora, respaldo de base de datos y exportación CSV.

## Datos, respaldo y reinicio

La base de datos vive en `data/mostrador.db` y está excluida de Git. Desde
**Configuración** puedes descargar un respaldo `.db` y exportar productos o
movimientos a CSV.

Para volver a los datos de demostración (borra todo lo registrado):

```bash
# Detén el servidor con Ctrl+C y luego:
rm -f data/mostrador.db data/mostrador.db-shm data/mostrador.db-wal
npm start
```

También puedes respaldar el archivo `data/mostrador.db` con el servidor detenido.

## Estructura

```text
server.js          Servidor HTTP, API y reglas de negocio
db.js              Esquema SQLite, ajustes, contadores y utilidades
seed.js            Datos de demostración
lib/receipt.js     Ticket/cotización de 48 columnas y totales
lib/printer.js     ESC/POS, CP437, USB y TCP
public/            Interfaz HTML/CSS/JS sin frameworks
data/              Base de datos local (se crea sola)
```

## Notas

- Los precios se guardan con IVA incluido por defecto; el ticket muestra base
  gravable e IVA desglosados.
- Las ventas anuladas no se borran: quedan en el historial y devuelven el stock.
- Los productos borrados se desactivan para no romper ventas históricas.
- El ticket es un documento interno, no fiscal. Para facturación electrónica DIAN
  se necesitaría una integración externa (fuera del alcance de esta versión).
- Esta versión es mono-usuario. Para varios puestos simultáneos se recomienda una
  base de datos cliente/servidor y control de concurrencia (fase posterior).
