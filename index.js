const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const { CustomerModel, LogModel, SettingsModel, PaymentModel, PackageModel, initDB } = require('./database');
const { client, sendNotification, getQrCode, isWhatsAppReady } = require('./whatsappService');
const { scheduleReminders } = require('./scheduler');
const { getMessageByType } = require('./notificationHelper');
const moment = require('moment');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para verificar si WhatsApp está vinculado
const checkWhatsApp = (req, res, next) => {
    if (process.env.SKIP_WHATSAPP === '1') {
        return next();
    }

    // Solo aplicar en rutas que no sean /login o archivos estáticos
    if (req.path === '/login' || req.path.startsWith('/img/')) {
        return next();
    }
    
    if (!isWhatsAppReady()) {
        return res.redirect('/login');
    }
    next();
};

// Configuración de Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(checkWhatsApp);

// Helpers de formato de fecha para EJS
app.locals.fDate = (value) => {
    if (!value) return '';
    const m = moment(value);
    return m.isValid() ? m.format('DD/MM/YYYY') : '';
};
app.locals.fDateTime = (value) => {
    if (!value) return '';
    const m = moment(value);
    return m.isValid() ? m.format('DD/MM/YYYY HH:mm:ss') : '';
};

const parseMoney = (value) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
};

// --- RUTAS WEB ---

// Ruta de Login (QR)
app.get('/login', (req, res) => {
    if (isWhatsAppReady()) {
        return res.redirect('/');
    }
    res.render('login', { qr: getQrCode() });
});

// 1. Dashboard principal
app.get('/', async (req, res) => {
    try {
        const customers = await CustomerModel.getAll();
        const logs = await LogModel.getAll();
        const monthStart = moment().startOf('month').format('YYYY-MM-DD');
        const monthEnd = moment().endOf('month').format('YYYY-MM-DD');
        const payments = await PaymentModel.getAll(monthStart, monthEnd);
        
        const stats = {
            totalCustomers: customers.length,
            sentMessages: logs.filter(l => l.status === 'Enviado').length,
            failedMessages: logs.filter(l => l.status === 'Fallido').length,
            totalCollected: payments.reduce((acc, p) => acc + p.amount, 0)
        };

        res.render('index', { stats, logs, now: new Date() });
    } catch (error) {
        res.status(500).send('Error cargando el dashboard');
    }
});

// 2. Gestión de clientes (ABC)
app.get('/customers', async (req, res) => {
    try {
        const customers = await CustomerModel.getAll();
        const packages = await PackageModel.getAll();
        res.render('customers', { customers, packages, notice: req.query.notice || '' });
    } catch (error) {
        res.status(500).send('Error cargando clientes');
    }
});

// 3. Alta de cliente
app.post('/add-customer', async (req, res) => {
    try {
        const { subscriber_number, name, phone, early_pay_date, early_pay_amount, normal_pay_amount, service_cut_amount, preferred_payment_day, package_id, send_notifications } = req.body;
        const pkgId = package_id ? parseInt(package_id, 10) : null;
        if (!pkgId) {
            return res.status(400).send('<p>Paquete es obligatorio.</p><a href="/customers">Volver</a>');
        }
        const pkg = await PackageModel.getById(pkgId);
        if (!pkg) {
            return res.status(400).send('<p>Paquete inválido.</p><a href="/customers">Volver</a>');
        }
        const sendNotifications = send_notifications ? 1 : 0;
        const preferredDay = parseInt(preferred_payment_day, 10);
        const early = moment(early_pay_date, 'YYYY-MM-DD', true);
        const correctedEarly = early.isValid()
            ? early.clone().date(Math.min(preferredDay, early.daysInMonth())).format('YYYY-MM-DD')
            : early_pay_date;
        
        // Calcular fechas automáticamente
        const normal_pay_date = moment(correctedEarly).add(4, 'days').format('YYYY-MM-DD');
        const service_cut_date = moment(correctedEarly).add(5, 'days').format('YYYY-MM-DD');

        let earlyAmount = Number(pkg.early_pay_amount);
        let normalAmount = Number(pkg.normal_pay_amount);
        let cutAmount = Number(pkg.service_cut_amount);

        await CustomerModel.create({
            subscriber_number,
            name,
            phone,
            early_pay_date: correctedEarly,
            normal_pay_date,
            service_cut_date,
            early_pay_amount: earlyAmount,
            normal_pay_amount: normalAmount,
            service_cut_amount: cutAmount,
            preferred_payment_day: preferredDay,
            package_id: pkgId,
            send_notifications: sendNotifications
        });
        res.redirect('/customers');
    } catch (error) {
        res.status(500).send('Error agregando cliente');
    }
});

// 4. Baja de cliente
app.post('/delete-customer/:id', async (req, res) => {
    try {
        await CustomerModel.delete(req.params.id);
        res.redirect('/customers');
    } catch (error) {
        res.status(500).send('Error eliminando cliente');
    }
});

// 5. Obtener cliente por ID (para edición)
app.get('/customer/:id', async (req, res) => {
    try {
        const customer = await CustomerModel.getById(req.params.id);
        res.json(customer);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener cliente' });
    }
});

// 6. Actualización de cliente
app.post('/edit-customer/:id', async (req, res) => {
    try {
        const { subscriber_number, name, phone, early_pay_date, early_pay_amount, normal_pay_amount, service_cut_amount, preferred_payment_day, package_id, send_notifications } = req.body;
        const pkgId = package_id ? parseInt(package_id, 10) : null;
        if (!pkgId) {
            return res.status(400).send('<p>Paquete es obligatorio.</p><a href="/customers">Volver</a>');
        }
        const pkg = await PackageModel.getById(pkgId);
        if (!pkg) {
            return res.status(400).send('<p>Paquete inválido.</p><a href="/customers">Volver</a>');
        }
        const sendNotifications = send_notifications ? 1 : 0;
        const preferredDay = parseInt(preferred_payment_day, 10);
        const early = moment(early_pay_date, 'YYYY-MM-DD', true);
        const correctedEarly = early.isValid()
            ? early.clone().date(Math.min(preferredDay, early.daysInMonth())).format('YYYY-MM-DD')
            : early_pay_date;
        
        // Recalcular fechas automáticas basadas en la nueva fecha de pronto pago
        const normal_pay_date = moment(correctedEarly).add(4, 'days').format('YYYY-MM-DD');
        const service_cut_date = moment(correctedEarly).add(5, 'days').format('YYYY-MM-DD');

        let earlyAmount = Number(pkg.early_pay_amount);
        let normalAmount = Number(pkg.normal_pay_amount);
        let cutAmount = Number(pkg.service_cut_amount);

        await CustomerModel.update(req.params.id, {
            subscriber_number,
            name,
            phone,
            early_pay_date: correctedEarly,
            normal_pay_date,
            service_cut_date,
            early_pay_amount: earlyAmount,
            normal_pay_amount: normalAmount,
            service_cut_amount: cutAmount,
            preferred_payment_day: preferredDay,
            package_id: pkgId,
            send_notifications: sendNotifications
        });
        res.redirect('/customers');
    } catch (error) {
        console.error('Error editando cliente:', error);
        res.status(500).send('Error actualizando cliente');
    }
});

app.post('/toggle-customer-notifications/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const enabled = req.body.enabled === '1' ? 1 : 0;
        await CustomerModel.update(id, { send_notifications: enabled });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

// Gestión de Paquetes
app.get('/packages', async (req, res) => {
    try {
        const packages = await PackageModel.getAll();
        res.render('packages', { packages });
    } catch (error) {
        res.status(500).send('Error cargando paquetes');
    }
});

app.get('/packages/json', async (req, res) => {
    try {
        const packages = await PackageModel.getAll();
        res.json(packages);
    } catch (error) {
        res.status(500).json({ error: 'Error cargando paquetes' });
    }
});

app.post('/packages/add', async (req, res) => {
    try {
        const { name, early_pay_amount, normal_pay_amount, service_cut_amount } = req.body;
        await PackageModel.create({
            name,
            early_pay_amount: parseFloat(early_pay_amount),
            normal_pay_amount: parseFloat(normal_pay_amount),
            service_cut_amount: parseFloat(service_cut_amount)
        });
        res.redirect('/packages');
    } catch (error) {
        res.status(500).send('Error creando paquete');
    }
});

app.post('/packages/edit/:id', async (req, res) => {
    try {
        const { name, early_pay_amount, normal_pay_amount, service_cut_amount } = req.body;
        await PackageModel.update(parseInt(req.params.id, 10), {
            name,
            early_pay_amount: parseFloat(early_pay_amount),
            normal_pay_amount: parseFloat(normal_pay_amount),
            service_cut_amount: parseFloat(service_cut_amount)
        });
        res.redirect('/packages');
    } catch (error) {
        res.status(500).send('Error actualizando paquete');
    }
});

app.post('/packages/delete/:id', async (req, res) => {
    try {
        await PackageModel.delete(parseInt(req.params.id, 10));
        res.redirect('/packages');
    } catch (error) {
        res.status(500).send('Error eliminando paquete');
    }
});

// 7. Envío manual de notificación
app.post('/send-manual/:id/:type', async (req, res) => {
    try {
        const customer = await CustomerModel.getById(req.params.id);
        const templates = await SettingsModel.getAll();
        const type = req.params.type;
        if (!customer) {
            return res.redirect('/customers');
        }
        if (customer.send_notifications === 0 || customer.send_notifications === '0') {
            await LogModel.add({
                customer_id: customer.id,
                customer_name: customer.name,
                phone: customer.phone,
                message: 'Auto desactivado: no se envió mensaje.',
                type: `${type} (Bloqueado)`,
                status: 'No Enviado (Auto OFF)'
            });
            return res.redirect('/customers?notice=auto_off');
        }
        const message = getMessageByType(customer, type, templates);

        if (message) {
            const success = await sendNotification(customer.phone, message);
            await LogModel.add({
                customer_id: customer.id,
                customer_name: customer.name,
                phone: customer.phone,
                message: message,
                type: type,
                status: success ? 'Enviado' : 'Fallido'
            });

            res.redirect('/customers');
        } else {
            res.status(400).send('Tipo de notificación inválido');
        }
    } catch (error) {
        console.error('Error en envío manual:', error);
        res.status(500).send('Error en envío manual');
    }
});

// 8. Cobranza
app.get('/billing', async (req, res) => {
    try {
        // Fechas para el REPORTE (filtros de usuario)
        const startDate = req.query.startDate || moment().startOf('month').format('YYYY-MM-DD');
        const endDate = req.query.endDate || moment().endOf('month').format('YYYY-MM-DD');
        
        // Fechas fijas para el CONTROL de cobranza (mes actual)
        const currentMonthStart = moment().startOf('month').format('YYYY-MM-DD');
        const currentMonthEnd = moment().endOf('month').format('YYYY-MM-DD');

        const allCustomers = await CustomerModel.getAll();
        
        // Pagos para el REPORTE (según filtro)
        const reportPayments = await PaymentModel.getAll(startDate, endDate);
        
        // Pagos para el CONTROL (solo mes actual)
        const currentMonthPayments = await PaymentModel.getAll(currentMonthStart, currentMonthEnd);

        const currentMonthMoment = moment();
        const daysInCurrentMonth = currentMonthMoment.daysInMonth();
        const cycleByCustomerId = new Map(allCustomers.map(c => {
            const preferredDay = c.preferred_payment_day || moment(c.early_pay_date).date();
            const targetDay = Math.min(preferredDay, daysInCurrentMonth);
            const cycle = currentMonthMoment.clone().date(targetDay).format('YYYY-MM-DD');
            return [c.id, cycle];
        }));
        
        const pendingCustomers = allCustomers.filter(c => {
            const cycle = cycleByCustomerId.get(c.id);
            const hasPaidForCurrentCycle = currentMonthPayments.some(p =>
                p.customer_id === c.id && (p.billing_cycle ? p.billing_cycle === cycle : true)
            );
            return !hasPaidForCurrentCycle;
        });
        
        const paidCustomersForCurrentCycle = currentMonthPayments.filter(p => {
            const cycle = cycleByCustomerId.get(p.customer_id);
            return cycle && (p.billing_cycle ? p.billing_cycle === cycle : true);
        });
        const paidCustomerIds = [...new Set(paidCustomersForCurrentCycle.map(p => p.customer_id))];
        
        const reportTotal = reportPayments.reduce((acc, p) => acc + p.amount, 0);
        const currentTotal = currentMonthPayments.reduce((acc, p) => acc + p.amount, 0);

        const isDefaultView = (startDate === currentMonthStart && endDate === currentMonthEnd);

        res.render('billing', {
            allCustomers,
            reportPayments,
            currentMonthPayments,
            startDate,
            endDate,
            isDefaultView,
            reportTotal,
            currentTotal,
            paidCustomersCount: paidCustomerIds.length,
            pendingCustomers,
            moment,
            today: moment().format('YYYY-MM-DD')
        });
    } catch (error) {
        console.error('Error en billing:', error);
        res.status(500).send('Error cargando módulo de cobranza');
    }
});

// 12. Generación de reporte de Cobranza PDF
app.get('/report-billing-pdf', async (req, res) => {
    try {
        const startDate = req.query.startDate || moment().startOf('month').format('YYYY-MM-DD');
        const endDate = req.query.endDate || moment().endOf('month').format('YYYY-MM-DD');
        
        const allCustomers = await CustomerModel.getAll();
        const payments = await PaymentModel.getAll(startDate, endDate);
        
        const paidCustomerIds = payments.map(p => p.customer_id);
        const paidCustomers = payments; // Ya tiene info de nombre y monto
        const pendingCustomers = allCustomers.filter(c => !paidCustomerIds.includes(c.id));
        const packageByCustomerId = new Map(allCustomers.map(c => [c.id, c.package_name]));

        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=reporte_cobranza_${startDate}_${endDate}.pdf`);
        
        doc.pipe(res);
        
        // Agregar Logo si existe
        const logoPath = path.join(__dirname, 'public', 'img', 'logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 50, 45, { width: 50 });
            doc.moveDown();
        }

        doc.fontSize(20).text('MASNET - Reporte Detallado de Cobranza', { align: 'center' });
        doc.fontSize(12).text(`Periodo: ${moment(startDate).format('DD/MM/YYYY')} al ${moment(endDate).format('DD/MM/YYYY')}`, { align: 'center' });
        doc.moveDown();

        // Resumen
        doc.fontSize(14).text('Resumen General:', { underline: true });
        doc.fontSize(12).text(`Total Recaudado: $${payments.reduce((acc, p) => acc + p.amount, 0).toFixed(2)}`);
        doc.text(`Clientes que Pagaron: ${paidCustomerIds.length}`);
        doc.text(`Clientes Pendientes: ${pendingCustomers.length}`);
        doc.moveDown();

        // Pagados
        doc.fontSize(14).text('CLIENTES QUE YA PAGARON:', { underline: true, color: 'green' });
        doc.moveDown(0.5);
        if (paidCustomers.length === 0) {
            doc.fontSize(10).text('No hay pagos registrados en este periodo.');
        } else {
            paidCustomers.forEach(p => {
                const pkgName = packageByCustomerId.get(p.customer_id);
                doc.fontSize(10).text(`- ${p.customer_name} | Paquete: ${pkgName || 'Sin paquete'} | Monto: $${p.amount.toFixed(2)} | Tipo: ${p.payment_type} | Fecha: ${app.locals.fDate(p.payment_date)}`);
            });
        }
        doc.moveDown();

        // Pendientes
        doc.fontSize(14).text('CLIENTES PENDIENTES DE PAGO:', { underline: true, color: 'red' });
        doc.moveDown(0.5);
        if (pendingCustomers.length === 0) {
            doc.fontSize(10).text('Todos los clientes han pagado.');
        } else {
            pendingCustomers.forEach(c => {
                doc.fontSize(10).text(`- ${c.subscriber_number} - ${c.name} | Paquete: ${c.package_name || 'Sin paquete'} | Cel: ${c.phone}`);
                doc.fontSize(8).text(`  (Pronto: ${app.locals.fDate(c.early_pay_date)} | Normal: ${app.locals.fDate(c.normal_pay_date)} | Corte: ${app.locals.fDate(c.service_cut_date)})`, { indent: 10 });
            });
        }

        doc.end();
    } catch (error) {
        console.error('Error generando reporte cobranza:', error);
        res.status(500).send('Error generando PDF');
    }
});

app.get('/report-billing-csv', async (req, res) => {
    try {
        const startDate = req.query.startDate || moment().startOf('month').format('YYYY-MM-DD');
        const endDate = req.query.endDate || moment().endOf('month').format('YYYY-MM-DD');
        const payments = await PaymentModel.getAll(startDate, endDate);
        const customers = await CustomerModel.getAll();
        const byId = new Map(customers.map(c => [c.id, c]));
        const paymentsByCustomerId = new Map();
        payments.forEach(p => {
            const list = paymentsByCustomerId.get(p.customer_id) || [];
            list.push(p);
            paymentsByCustomerId.set(p.customer_id, list);
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=reporte_cobranza_${startDate}_${endDate}.csv`);

        const headers = ['Estado','Suscriptor','Cliente','Paquete','Teléfono','Monto','Tipo','Fecha','Ciclo'];
        const escape = (value) => {
            if (value === null || value === undefined) return '';
            const str = String(value).replace(/"/g, '""');
            return `"${str}"`;
        };

        const rows = [];
        customers.forEach(c => {
            const list = paymentsByCustomerId.get(c.id) || [];
            if (list.length === 0) {
                rows.push([
                    'PENDIENTE',
                    c.subscriber_number || '',
                    c.name || '',
                    c.package_name || '',
                    c.phone || '',
                    '',
                    '',
                    '',
                    ''
                ]);
                return;
            }
            list.forEach(p => {
                rows.push([
                    'PAGADO',
                    c.subscriber_number || '',
                    p.customer_name || c.name || '',
                    c.package_name || '',
                    c.phone || '',
                    (Number(p.amount) || 0).toFixed(2),
                    p.payment_type || '',
                    app.locals.fDate(p.payment_date),
                    p.billing_cycle ? app.locals.fDate(p.billing_cycle) : ''
                ]);
            });
        });

        const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\r\n');
        res.send(`\ufeff${csv}`);
    } catch (error) {
        res.status(500).send('Error generando CSV de cobranza');
    }
});

app.post('/register-payment', async (req, res) => {
    try {
        const { customer_id, amount, payment_type, payment_date } = req.body;
        
        // 1. Obtener los datos del cliente antes de cualquier cambio
        const customer = await CustomerModel.getById(customer_id);
        if (!customer) throw new Error('Cliente no encontrado');

        // 2. Calcular las NUEVAS fechas basadas en la fecha de pronto pago actual
        const currentEarlyPay = moment(customer.early_pay_date);
        const preferredDay = customer.preferred_payment_day || currentEarlyPay.date();
        const nextMonth = currentEarlyPay.clone().add(1, 'month');
        const targetDay = Math.min(preferredDay, nextMonth.daysInMonth());
        const nextEarlyPay = nextMonth.date(targetDay).format('YYYY-MM-DD');
        const nextNormalPay = moment(nextEarlyPay).add(4, 'days').format('YYYY-MM-DD');
        const nextServiceCut = moment(nextEarlyPay).add(5, 'days').format('YYYY-MM-DD');

        console.log(`--- Iniciando Registro de Pago para ${customer.name} ---`);
        console.log(`Fechas actuales: ${customer.early_pay_date}`);
        console.log(`Nuevas fechas calculadas: ${nextEarlyPay}`);

        // 3. Registrar el pago
        await PaymentModel.add({
            customer_id,
            customer_name: customer.name,
            amount: parseFloat(amount),
            payment_type,
            payment_date,
            billing_cycle: customer.early_pay_date
        });

        // 4. Actualizar las fechas en la base de datos
        await CustomerModel.update(customer.id, {
            early_pay_date: nextEarlyPay,
            normal_pay_date: nextNormalPay,
            service_cut_date: nextServiceCut
        });
        
        console.log(`Actualización exitosa para ${customer.name}. Nueva fecha: ${nextEarlyPay}`);

        // 5. Agradecimiento opcional
        const settings = await SettingsModel.getAll();
        if (settings.enable_thank_you === 'true') {
            const thankYouMessage = getMessageByType({ ...customer, amount: parseFloat(amount), payment_type }, 'Agradecimiento', settings);
            const success = await sendNotification(customer.phone, thankYouMessage);
            await LogModel.add({ customer_id: customer.id, customer_name: customer.name, phone: customer.phone, message: thankYouMessage, type: 'Agradecimiento', status: success ? 'Enviado' : 'Fallido' });
        }
        
        res.redirect(`/billing?startDate=${req.body.currentStartDate || ''}&endDate=${req.body.currentEndDate || ''}`);
    } catch (error) {
        console.error('Error crítico en registro de pago:', error);
        res.status(500).send('Error registrando pago: ' + error.message);
    }
});

// Ruta para borrar pago
app.post('/delete-payment/:id', async (req, res) => {
    try {
        const paymentId = req.params.id;
        console.log('Intentando eliminar pago con ID:', paymentId);
        
        if (!paymentId) {
            throw new Error('ID de pago no proporcionado');
        }

        // Obtener detalles del pago antes de borrarlo
        const payment = await PaymentModel.getById(paymentId);
        if (!payment) {
            throw new Error('El pago no existe');
        }

        const customerId = payment.customer_id;
        await PaymentModel.delete(paymentId);
        
        // Regresamos las fechas al mes anterior tras eliminar cualquier pago
        const customer = await CustomerModel.getById(customerId);
        if (customer) {
            const currentEarlyPay = moment(customer.early_pay_date);

            const preferredDay = customer.preferred_payment_day || currentEarlyPay.date();
            const prevMonth = currentEarlyPay.clone().subtract(1, 'month');
            const targetDay = Math.min(preferredDay, prevMonth.daysInMonth());
            const oldEarlyPay = prevMonth.date(targetDay).format('YYYY-MM-DD');
            const oldNormalPay = moment(oldEarlyPay).add(4, 'days').format('YYYY-MM-DD');
            const oldServiceCut = moment(oldEarlyPay).add(5, 'days').format('YYYY-MM-DD');

            console.log(`Revirtiendo fechas para ${customer.name}:`);
            console.log(`- Fecha actual: ${customer.early_pay_date}`);
            console.log(`- Nueva fecha (revertida): ${oldEarlyPay}`);

            await CustomerModel.update(customer.id, {
                early_pay_date: oldEarlyPay,
                normal_pay_date: oldNormalPay,
                service_cut_date: oldServiceCut
            });
            console.log(`Base de datos revertida con éxito para ${customer.name}.`);
        }
        
        // Usamos req.body porque ahora pasamos las fechas como inputs ocultos en el form POST
        const startDate = req.body.startDate || '';
        const endDate = req.body.endDate || '';
        
        const redirectUrl = `/billing?startDate=${startDate}&endDate=${endDate}`;
        console.log('Pago eliminado con éxito. Redirigiendo a:', redirectUrl);
        res.redirect(redirectUrl);
    } catch (error) {
        console.error('Error detallado al eliminar pago:', error);
        res.status(500).send(`
            <div style="font-family: sans-serif; padding: 20px;">
                <h2 style="color: #dc3545;">Error al eliminar el pago</h2>
                <p>Ocurrió un problema al intentar procesar la solicitud.</p>
                <p><strong>Detalle:</strong> ${error.message}</p>
                <a href="/billing" style="display: inline-block; padding: 10px 20px; background-color: #0d6efd; color: white; text-decoration: none; border-radius: 5px;">Volver a Cobranza</a>
            </div>
        `);
    }
});

app.post('/edit-late-payment/:id', async (req, res) => {
    try {
        const paymentId = req.params.id;
        if (!paymentId) {
            throw new Error('ID de pago no proporcionado');
        }

        const payment = await PaymentModel.getById(paymentId);
        if (!payment) {
            throw new Error('El pago no existe');
        }

        const amount = Number(req.body.amount);
        if (!Number.isFinite(amount)) {
            throw new Error('Monto inválido');
        }

        await PaymentModel.updateAmount(paymentId, amount);

        const startDate = req.body.startDate || '';
        const endDate = req.body.endDate || '';
        
        res.redirect(`/billing?startDate=${startDate}&endDate=${endDate}`);
    } catch (error) {
        console.error('Error al editar pago atrasado:', error);
        res.status(500).send(`
            <div style="font-family: sans-serif; padding: 20px;">
                <h2 style="color: #dc3545;">Error al editar el pago atrasado</h2>
                <p>Ocurrió un problema al intentar procesar la solicitud.</p>
                <p><strong>Detalle:</strong> ${error.message}</p>
                <a href="/billing" style="display: inline-block; padding: 10px 20px; background-color: #0d6efd; color: white; text-decoration: none; border-radius: 5px;">Volver a Cobranza</a>
            </div>
        `);
    }
});

// 9. Configuración de mensajes
app.get('/settings', async (req, res) => {
    try {
        const settings = await SettingsModel.getAll();
        res.render('settings', { settings });
    } catch (error) {
        res.status(500).send('Error cargando configuración');
    }
});

app.post('/save-settings', async (req, res) => {
    try {
        const settings = await SettingsModel.getAll();
        const allKeys = ['template_pronto_pago', 'template_pago_normal', 'template_corte_servicio', 'template_thank_you'];
        
        // Guardar plantillas de texto
        for (const key of allKeys) {
            if (req.body[key] !== undefined) {
                await SettingsModel.update(key, req.body[key]);
            }
        }

        // Guardar estado del switch (enable_thank_you)
        const enableThankYou = req.body.enable_thank_you === 'true' ? 'true' : 'false';
        await SettingsModel.update('enable_thank_you', enableThankYou);

        res.redirect('/settings');
    } catch (error) {
        res.status(500).send('Error guardando configuración');
    }
});

// 10. Historial de envíos
app.get('/logs', async (req, res) => {
    try {
        const logs = await LogModel.getAll();
        res.render('logs', { logs });
    } catch (error) {
        res.status(500).send('Error cargando historial');
    }
});

app.post('/logs/clear', async (req, res) => {
    try {
        await LogModel.clearAll();
        res.redirect('/logs');
    } catch (error) {
        res.status(500).send('Error borrando historial');
    }
});

// 11. Generación de reporte PDF
app.get('/report-pdf', async (req, res) => {
    try {
        const logs = await LogModel.getAll();
        const doc = new PDFDocument();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=reporte_envios.pdf');
        
        doc.pipe(res);
        
        // Agregar Logo si existe
        const logoPath = path.join(__dirname, 'public', 'img', 'logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 50, 45, { width: 50 });
            doc.moveDown();
        }

        doc.fontSize(20).text('MASNET - Reporte de Mensajes de WhatsApp', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Fecha del reporte: ${moment().format('DD/MM/YYYY HH:mm:ss')}`);
        doc.moveDown();
        
        logs.forEach(log => {
            doc.fontSize(10).text(`--------------------------------------------------`);
            doc.text(`Fecha: ${app.locals.fDateTime(log.sent_at)}`);
            doc.text(`Cliente: ${log.customer_name} (${log.phone})`);
            if (log.package_name) doc.text(`Paquete: ${log.package_name}`);
            doc.text(`Tipo: ${log.type}`);
            doc.text(`Mensaje: ${log.message}`);
            doc.text(`Estado: ${log.status}`);
            doc.moveDown(0.5);
        });
        
        doc.end();
    } catch (error) {
        res.status(500).send('Error generando PDF');
    }
});

app.get('/report-csv', async (req, res) => {
    try {
        const logs = await LogModel.getAll();
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=reporte_envios.csv');
        const headers = ['Fecha y Hora','Cliente','Paquete','Teléfono','Tipo','Estado','Mensaje'];
        const escape = (value) => {
            if (value === null || value === undefined) return '';
            const str = String(value).replace(/"/g, '""');
            return `"${str}"`;
        };
        const rows = logs.map(l => [
            app.locals.fDateTime(l.sent_at),
            l.customer_name,
            l.package_name || '',
            l.phone,
            l.type,
            l.status,
            l.message
        ]);
        const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\r\n');
        res.send(`\ufeff${csv}`);
    } catch (error) {
        res.status(500).send('Error generando CSV');
    }
});

// --- INICIALIZACIÓN ---

async function startServer() {
    try {
        // Inicializar DB
        await initDB();
        
        // Iniciar WhatsApp
        if (process.env.SKIP_WHATSAPP !== '1') {
            client.initialize().catch(err => {
                console.error('Error iniciando WhatsApp:', err);
            });
        }
        
        // Programar recordatorios
        scheduleReminders();
        
        // Escuchar Express
        app.listen(PORT, () => {
            console.log(`--- Servidor gráfico iniciado en http://localhost:${PORT} ---`);
        });
    } catch (error) {
        console.error('Error al iniciar el sistema:', error);
    }
}

startServer();
