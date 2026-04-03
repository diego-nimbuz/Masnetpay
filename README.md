# WhatsApp SQL Reminder System

Sistema de gestión de clientes (ABC) con notificaciones automáticas de pago por WhatsApp y base de datos SQLite.

## Características

- **Gestión de Clientes (ABC)**: Altas, Bajas y Cambios de clientes almacenados en una base de datos local SQLite (`customers.db`).
- **Fechas de Pago Automáticas**:
  - **Pronto Pago**: Recordatorio de descuento.
  - **Pago Normal**: Recordatorio de fecha límite.
  - **Corte de Servicio**: Aviso de suspensión.
- **WhatsApp**: Conexión mediante `whatsapp-web.js` con autenticación por código QR.
- **Automatización**: Tarea programada (Cron) para enviar mensajes todos los días a las 09:00 AM.

## Requisitos

- Node.js (v14 o superior)
- npm

## Instalación

1.  Abre una terminal en el directorio del proyecto.
2.  Instala las dependencias:
    ```bash
    npm install
    ```

## Configuración y Uso

1.  Para iniciar el sistema:
    ```bash
    npm start
    ```
2.  Escanea el código QR que aparecerá en la terminal con tu aplicación de WhatsApp.
3.  Una vez autenticado, el sistema:
    - Inicializará la base de datos `customers.db`.
    - Programará los recordatorios diarios.
    - Insertará un cliente de prueba (si la base está vacía) para demostración.

## Formato de Teléfono

Asegúrate de registrar los números con el código de país (ejemplo para México: `5215512345678`).

## Gestión de Clientes (ABC)

Puedes gestionar tus clientes a través del archivo `database.js` y `index.js` utilizando las funciones de `CustomerModel`:

- `CustomerModel.create({ ... })` - Crear un nuevo cliente.
- `CustomerModel.update(id, { ... })` - Actualizar datos de un cliente existente.
- `CustomerModel.delete(id)` - Eliminar a un cliente.
- `CustomerModel.getAll()` - Obtener la lista completa de clientes.
