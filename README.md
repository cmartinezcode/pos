# Mostrador POS · 80 mm

POS para ferretería/tornillería con estética de terminal, pensado para usarse
con teclado, ratón o lector de código de barras. Imprime tickets internos de
80 mm desde el navegador (o los guarda como PDF). **No emite facturación
electrónica DIAN.**

Esta versión corre en **Cloudflare Workers + D1 + Static Assets** y también en
local con Node.js, usando exactamente el mismo código de negocio.

---

## 1. Arquitectura

```
public/            interfaz (HTML/CSS/JS sin frameworks)
src/worker.js      entrada Cloudflare: sesión + Static Assets
src/app.js         API portable (misma para Worker y Node)
src/store.js       ventas, cotizaciones, inventario, reportes, respaldo
src/auth.js        PBKDF2 + cookie HMAC (Web Crypto)
src/db.d1.js       adaptador D1 (escrituras atómicas con batch)
src/db.node.js     adaptador local sobre node:sqlite
db.js              esquema SQLite y utilidades puras
migrations/        0001 esquema · 0002 datos iniciales
server.js          servidor local de desarrollo
```

- Una sola base SQLite: el mismo SQL funciona en local y en D1.
- Ventas, cotizaciones, anulaciones y ajustes usan **una transacción atómica**
  (`db.batch()`): o se guarda todo, o no se guarda nada.
- Los ids se generan con secuencias explícitas (`counters.seq_*`), sin depender
  de `lastInsertRowid`.
- Cada cobro lleva `request_id`: si se repite el envío por mala conexión, el
  servidor devuelve la venta existente y **no cobra ni descuenta dos veces**.
- Si `allow_negative_stock = false`, una guardia SQL aborta la transacción
  completa cuando falta stock.
- La zona horaria del negocio se guarda en `settings.timezone`
  (por defecto `America/Bogota`).

---

## 2. Uso local (desarrollo)

Requisitos: Node.js 22.5 o superior (usa `node:sqlite`). No hay dependencias
npm para ejecutar la app.

```bash
cd ~/mostrador
npm start
```

Abre `http://127.0.0.1:3000`. Usa la base existente en `data/mostrador.db`.

Para crear una base nueva con los datos iniciales:

```bash
npm run db:init -- data/mostrador.db
```

Para acceder desde otro equipo de la red local:

```bash
HOST=0.0.0.0 npm start
```

Variables útiles:

| Variable | Uso |
| --- | --- |
| `PORT` | puerto HTTP (por defecto `3000`) |
| `HOST` | interfaz de escucha (por defecto `127.0.0.1`) |
| `DB_PATH` | ruta alterna de la base |
| `AUTH_SECRET` | si se define, activa el login también en local |
| `INITIAL_PASSWORD` | clave inicial cuando se activa el login |

En local **sin** `AUTH_SECRET` no se pide clave, para no estorbar el desarrollo.

---

## 3. Despliegue en Cloudflare (gratis)

Todo el proceso usa el plan gratuito: Workers, D1 y Static Assets. No hace falta
tarjeta ni dominio propio; se usa la URL `https://<nombre>.<usuario>.workers.dev`.

### 3.1 Preparar

```bash
cd ~/mostrador
npm install            # instala wrangler (solo desarrollo/despliegue)
npx wrangler login     # abre el navegador una vez
```

### 3.2 Crear la base D1

```bash
npx wrangler d1 create mostrador
```

Copia el `database_id` que devuelve y reemplázalo en `wrangler.jsonc`
(donde dice `REEMPLAZA_CON_EL_ID_DE_D1`).

### 3.3 Cargar esquema y datos

```bash
npm run cf:migrate
```

Aplica `0001_init.sql` (esquema) y `0002_seed.sql` (productos, categorías,
clientes y ventas exportadas de la base local). Si prefieres empezar vacío,
borra o renombra `0002_seed.sql` antes de aplicar.

### 3.4 Configurar secretos

Genera una clave larga y aleatoria para firmar sesiones:

```bash
openssl rand -base64 48
```

Guárdala como secreto (nunca en el repositorio ni en el frontend):

```bash
npx wrangler secret put AUTH_SECRET
npx wrangler secret put INITIAL_PASSWORD
```

`INITIAL_PASSWORD` es la clave con la que entrarás la primera vez (mínimo 8
caracteres). En el primer login se guarda **cifrada con PBKDF2** en la base y el
secreto ya no se vuelve a usar. Después puedes cambiarla desde
**Configuración → Acceso y sesión**.

Opcional: `AUTH_ITERATIONS` (por defecto `10000`). Súbelo si tu plan aguanta más
CPU; bájalo solo si el login excede el límite de CPU del plan Free.

### 3.5 Publicar

```bash
npm run cf:deploy
```

Abre la URL que imprime Wrangler. Debe redirigir a `/login`. Entra con
`INITIAL_PASSWORD`.

Para probar el Worker y D1 en local antes de publicar:

```bash
npm run cf:dev
```

Crea `.dev.vars` (ignorado por Git) a partir de `.dev.vars.example` con los
mismos secretos de prueba:

```bash
cp .dev.vars.example .dev.vars
# edita .dev.vars
```

```ini
AUTH_SECRET="una-cadena-larga-de-prueba"
INITIAL_PASSWORD="clave12345"
```

Las migraciones locales se aplican con `npm run cf:migrate:local`.

> El Worker **falla cerrado**: si falta `AUTH_SECRET`, responde 503 en todo.
> Así no se publica el POS abierto por accidente.

---

## 4. Acceso privado y seguridad

- Login propio, sin depender de Cloudflare Access ni de un dominio.
- Contraseña con PBKDF2-SHA-256 (sal aleatoria por instalación).
- Cookie de sesión `HttpOnly; Secure; SameSite=Strict`, firmada con HMAC-SHA-256
  y válida 30 días.
- Límite de intentos: 8 fallos por IP en 15 minutos.
- Toda la API exige sesión salvo `/api/login`, `/api/session` y `/api/health`.
- Las páginas `/` e `/index.html` redirigen al login si no hay sesión.
- Todas las consultas usan parámetros enlazados (sin concatenar datos).
- El respaldo SQL **no incluye** el hash de la clave.
- Para invalidar todas las sesiones de golpe, cambia `AUTH_SECRET`.
- Para revocar una clave olvidada:
  ```bash
  npx wrangler d1 execute mostrador --remote \
    --command "DELETE FROM settings WHERE key = 'auth_password'"
  npx wrangler secret put INITIAL_PASSWORD
  ```
  El siguiente login vuelve a crear la clave con el secreto nuevo.

---

## 5. Respaldos y recuperación

### 5.1 Automático: Time Travel de D1

El plan Free conserva **7 días** de puntos de recuperación (verifica el plazo
vigente en la documentación de Cloudflare antes de confiar solo en esto).

```bash
npx wrangler d1 time-travel info mostrador
npx wrangler d1 time-travel restore mostrador --timestamp=<unix>
```

### 5.2 Manual: descarga SQL

En **Configuración → Respaldo `.sql`**, o directamente:

```bash
curl -b cookie.txt https://TU-URL/api/backup -o mostrador-$(date +%F).sql
```

El archivo contiene `INSERT OR REPLACE` de todas las tablas de negocio, sin el
hash de la clave. Es portable y legible. Para bases muy grandes usa Time Travel;
el volcado está pensado para el tamaño normal de un POS.

También hay exportaciones CSV de productos y kardex en la misma pantalla.

### 5.3 Restaurar el volcado en una base nueva

```bash
npx wrangler d1 execute mostrador-nuevo --remote --file=migrations/0001_init.sql
npx wrangler d1 execute mostrador-nuevo --remote --file=mostrador-2026-11-14.sql
```

Luego apunta `database_id` a la base nueva y vuelve a desplegar. Restaura siempre
sobre una base **vacía** para evitar conflictos de claves. El volcado no incluye
la clave: tras restaurar, define de nuevo `INITIAL_PASSWORD` y entra una vez para
volver a crearla.

### 5.4 Restaurar en local

```bash
rm -f data/mostrador.db
sqlite3 data/mostrador.db < migrations/0001_init.sql
sqlite3 data/mostrador.db < mostrador-2026-11-14.sql
```

### 5.5 Recomendación

- Un volcado manual al mes y antes de cada cambio grande.
- No guardes respaldos con datos reales en el repositorio.
- Verifica de vez en cuando que el volcado abre y tiene los conteos esperados.

---

## 6. Límites del plan gratuito

Verificados al momento de la migración; Cloudflare puede cambiarlos. Revisa la
página oficial antes de asumir que sigue siendo gratis.

| Recurso | Plan Free |
| --- | --- |
| Workers | 100.000 peticiones/día, 10 ms CPU por petición |
| Workers: consultas/subpeticiones | 50 por invocación (un `db.batch()` cuenta como 1) |
| D1 lectura | 5.000.000 filas/día |
| D1 escritura | 100.000 filas/día |
| D1 almacenamiento | 5 GB total, 500 MB por base |
| D1 bases por cuenta | 10 |
| D1 Time Travel | 7 días |
| D1 patrón `LIKE` | 50 bytes máximo |
| D1 resultado de consulta | 50 MB máximo |
| Static Assets | sin costo aparte, 20.000 archivos |
| Dominio | no incluido (se usa `workers.dev`) |

Consultado en la documentación oficial de Cloudflare el 14 de noviembre de 2026.

Notas prácticas:

- Un `db.batch()` cuenta como una sola consulta frente al límite de 50
  consultas por invocación.
- Las rutas más pesadas (convertir cotización) usan ~20 consultas.
- El respaldo SQL descarga hasta 50 MB; para bases mayores usa Time Travel.
- Si algún día el negocio supera estos límites, el plan Paid es de pago por uso;
  el código no cambia.

---

## 7. Impresión de 80 mm

En la nube el Worker no puede hablar con USB ni con la red local. El flujo es:

1. Al cobrar, se abre la vista previa del ticket.
2. **Imprimir 80 mm** abre el diálogo del navegador (PC o teléfono).
3. Puedes elegir la impresora térmica o guardar como PDF.

La opción **Imprimir al cobrar** queda guardada en la configuración. Cuando se
use una impresora de red en el futuro, se puede añadir un pequeño puente local
sin cambiar el modelo de datos.

---

## 8. Verificación

```bash
npm run check          # sintaxis de todos los módulos
npm start              # prueba local completa
npm run cf:dev         # Worker + D1 local (wrangler)
```

Pruebas realizadas en esta migración (Node local **y** `wrangler dev` con D1 real):

- login correcto/incorrecto, cookie manipulada, logout, cambio de clave,
  límite de intentos;
- venta, reintento idempotente, ticket, anulación y restauración de stock;
- rechazo por stock insuficiente sin escrituras parciales;
- cotización crear/editar/convertir y doble conversión rechazada;
- reportes, kardex, búsqueda, CSV y respaldo SQL;
- migraciones y datos iniciales sobre una base vacía;
- restauración del volcado SQL en una base limpia, con conteos y secuencias
  correctos y sin el hash de la clave.

---

## 9. Volver a la versión anterior

La versión previa quedó respaldada fuera del proyecto:

- `~/backups/mostrador-pre-cloudflare-20261114/mostrador.db`
- `~/backups/mostrador-pre-cloudflare-20261114/mostrador-src.tar.gz`
- etiqueta Git `pre-cloudflare`

```bash
cd ~/mostrador
git checkout pre-cloudflare
npm start
```

La rama de la migración es `cloudflare`.

---

## 10. Estructura de datos principal

`settings`, `categories`, `units`, `products`, `presentations`, `customers`,
`quotes`, `quote_items`, `sales`, `sale_items`, `stock_movements`, `counters`,
`guards` (guardia transaccional) y `login_attempts` (límite de acceso).

Las ventas guardan precio, costo, IVA y descuento por línea, más el total
congelado al momento del cobro. Anular una venta no la borra: cambia su estado
y devuelve el stock con un movimiento de kardex.
