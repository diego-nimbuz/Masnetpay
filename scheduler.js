const cron = require('node-cron');
const moment = require('moment');
const { CustomerModel, LogModel, SettingsModel, PaymentModel } = require('./database');
const { sendNotification } = require('./whatsappService');
const { getMessageByType } = require('./notificationHelper');

const TIMEZONE = 'America/Mexico_City';

function todayYMDInTimeZone(timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

/**
 * Revisa todos los clientes para ver si alguno tiene una fecha de pago próxima.
 */
async function checkAndSendReminders() {
    console.log('--- Iniciando revisión de recordatorios diarios ---');
    try {
        const customers = await CustomerModel.getAll();
        const templates = await SettingsModel.getAll();
        const today = todayYMDInTimeZone(TIMEZONE);

        for (const customer of customers) {
            const hasPaidForCurrentCycle = await PaymentModel.hasPaidForCycle(customer.id, customer.early_pay_date);
            if (hasPaidForCurrentCycle) {
                console.log(`Saltando recordatorios para ${customer.name} (ya pagó para el ciclo: ${customer.early_pay_date})`);
                continue;
            }

            const early = moment.utc(customer.early_pay_date, 'YYYY-MM-DD', true);
            const normal = moment.utc(customer.normal_pay_date, 'YYYY-MM-DD', true);
            const cut = moment.utc(customer.service_cut_date, 'YYYY-MM-DD', true);

            if (!early.isValid() || !normal.isValid() || !cut.isValid()) {
                continue;
            }

            const prontoMinus4 = early.clone().subtract(4, 'days').format('YYYY-MM-DD');
            const prontoDay = early.format('YYYY-MM-DD');
            const normalPlus1 = early.clone().add(1, 'days').format('YYYY-MM-DD');
            const normalDay = normal.format('YYYY-MM-DD');
            const cutDay = cut.format('YYYY-MM-DD');

            const reminders = [];
            if (today === prontoMinus4) reminders.push({ baseType: 'Pronto Pago', logType: 'Pronto Pago (4 días antes)' });
            if (today === prontoDay) reminders.push({ baseType: 'Pronto Pago', logType: 'Pronto Pago' });
            if (today === normalPlus1) reminders.push({ baseType: 'Pago Normal', logType: 'Pago Normal (1 día después de Pronto Pago)' });
            if (today === normalDay) reminders.push({ baseType: 'Pago Normal', logType: 'Pago Normal' });
            if (today === cutDay) reminders.push({ baseType: 'Corte de Servicio', logType: 'Corte de Servicio' });

            if (customer.send_notifications === 0 || customer.send_notifications === '0') {
                if (reminders.length > 0) {
                    for (const r of reminders) {
                        await LogModel.add({
                            customer_id: customer.id,
                            customer_name: customer.name,
                            phone: customer.phone,
                            message: 'Auto desactivado: no se envió mensaje programado.',
                            type: `${r.logType} (Bloqueado)`,
                            status: 'No Enviado (Auto OFF)'
                        });
                    }
                }
                continue;
            }

            for (const r of reminders) {
                const message = getMessageByType(customer, r.baseType, templates);
                if (!message) continue;

                const success = await sendNotification(customer.phone, message);
                await LogModel.add({
                    customer_id: customer.id,
                    customer_name: customer.name,
                    phone: customer.phone,
                    message: message,
                    type: r.logType,
                    status: success ? 'Enviado' : 'Fallido'
                });

                if (r.baseType === 'Corte de Servicio') {
                    continue;
                }
            }
        }
        console.log('--- Revisión de recordatorios completada ---');
    } catch (error) {
        console.error('Error procesando recordatorios:', error);
    }
}

/**
 * Programa la tarea para que se ejecute todos los días a las 9:00 AM.
 */
function scheduleReminders() {
    // Configura la hora que prefieras (ejemplo: cada día a las 09:00)
    cron.schedule('0 9 * * *', () => {
        checkAndSendReminders();
    }, { timezone: TIMEZONE });
    console.log(`Tarea programada: Recordatorios diarios a las 09:00 AM (${TIMEZONE})`);
}

module.exports = { scheduleReminders, checkAndSendReminders };
