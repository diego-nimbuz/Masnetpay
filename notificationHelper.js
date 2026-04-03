/**
 * Helper para generar los mensajes de notificación por tipo.
 * @param {Object} customer Objeto del cliente con name.
 * @param {string} type Tipo de mensaje ('Pronto Pago', 'Pago Normal', 'Corte de Servicio')
 * @param {Object} templates Objeto con las plantillas de la DB.
 * @returns {string} Mensaje formateado.
 */
const moment = require('moment');

function formatDateDDMMYYYY(value) {
    if (!value) return '';
    const m = moment(value, ['YYYY-MM-DD', moment.ISO_8601], true);
    return m.isValid() ? m.format('DD/MM/YYYY') : '';
}

function formatMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function replaceToken(message, token, value) {
    const safe = value === null || value === undefined ? '' : String(value);
    const re = new RegExp(`\\{\\s*${token}\\s*\\}`, 'gi');
    return message.replace(re, safe);
}

function getMessageByType(customer, type, templates) {
    let template = '';
    let amount = 0;
    
    switch (type) {
        case 'Pronto Pago':
            template = templates.template_pronto_pago;
            amount = customer.early_pay_amount;
            break;
        case 'Pago Normal':
            template = templates.template_pago_normal;
            amount = customer.normal_pay_amount;
            break;
        case 'Corte de Servicio':
            template = templates.template_corte_servicio;
            amount = customer.service_cut_amount;
            break;
        case 'Agradecimiento':
            template = templates.template_thank_you;
            // El monto ya viene en el objeto customer para este caso específico
            amount = customer.amount; 
            break;
    }

    if (!template) return '';

    // Reemplazar marcadores de posición
    let message = template;
    message = replaceToken(message, 'name', customer.name || '');
    message = replaceToken(message, 'subscriber_number', customer.subscriber_number || '');
    message = replaceToken(message, 'subscriber', customer.subscriber_number || '');

    message = replaceToken(message, 'early_pay_date', formatDateDDMMYYYY(customer.early_pay_date));
    message = replaceToken(message, 'normal_pay_date', formatDateDDMMYYYY(customer.normal_pay_date));
    message = replaceToken(message, 'service_cut_date', formatDateDDMMYYYY(customer.service_cut_date));

    message = replaceToken(message, 'early_pay_amount', formatMoney(customer.early_pay_amount));
    message = replaceToken(message, 'normal_pay_amount', formatMoney(customer.normal_pay_amount));
    message = replaceToken(message, 'service_cut_amount', formatMoney(customer.service_cut_amount));

    message = replaceToken(message, 'amount', formatMoney(amount));
    message = replaceToken(message, 'type', customer.payment_type || type);
    
    return message;
}

module.exports = { getMessageByType };
