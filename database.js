const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const moment = require('moment');

const dbPath = path.resolve(__dirname, 'customers.db');
const db = new sqlite3.Database(dbPath);
db.configure('busyTimeout', 5000);

function ensureColumn(tableName, columnName, columnType) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
            if (err) return reject(err);
            const hasColumn = rows.some(r => r.name === columnName);
            if (hasColumn) return resolve(false);
            db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, [], (alterErr) => {
                if (alterErr) return reject(alterErr);
                resolve(true);
            });
        });
    });
}

function backfillPreferredPaymentDay() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(
                `UPDATE customers
                 SET preferred_payment_day = CAST(substr(early_pay_date, 9, 2) AS INTEGER)
                 WHERE preferred_payment_day IS NULL AND early_pay_date LIKE '____-__-__'`,
                [],
                (err) => {
                    if (err) return reject(err);

                    db.run(
                        `UPDATE customers
                         SET preferred_payment_day = (
                             SELECT MAX(CAST(substr(billing_cycle, 9, 2) AS INTEGER))
                             FROM payments
                             WHERE payments.customer_id = customers.id
                               AND billing_cycle IS NOT NULL
                               AND billing_cycle != ''
                         )
                         WHERE EXISTS (
                             SELECT 1
                             FROM payments
                             WHERE payments.customer_id = customers.id
                               AND billing_cycle IS NOT NULL
                               AND billing_cycle != ''
                         )
                           AND (preferred_payment_day IS NULL OR preferred_payment_day < (
                               SELECT MAX(CAST(substr(billing_cycle, 9, 2) AS INTEGER))
                               FROM payments
                               WHERE payments.customer_id = customers.id
                                 AND billing_cycle IS NOT NULL
                                 AND billing_cycle != ''
                           ))`,
                        [],
                        (err2) => {
                            if (err2) return reject(err2);
                            resolve();
                        }
                    );
                }
            );
        });
    });
}

function normalizeCustomerDates() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT id, early_pay_date, preferred_payment_day FROM customers`,
            [],
            (err, rows) => {
                if (err) return reject(err);

                const updates = rows
                    .map(r => {
                        const preferredDay = Number(r.preferred_payment_day);
                        if (!Number.isFinite(preferredDay)) return null;

                        const early = moment(r.early_pay_date, 'YYYY-MM-DD', true);
                        if (!early.isValid()) return null;

                        const targetDay = Math.min(preferredDay, early.daysInMonth());
                        const correctedEarly = early.clone().date(targetDay).format('YYYY-MM-DD');
                        if (correctedEarly === r.early_pay_date) return null;

                        const correctedNormal = moment(correctedEarly).add(4, 'days').format('YYYY-MM-DD');
                        const correctedCut = moment(correctedEarly).add(5, 'days').format('YYYY-MM-DD');

                        return { id: r.id, correctedEarly, correctedNormal, correctedCut };
                    })
                    .filter(Boolean);

                if (updates.length === 0) return resolve();

                db.serialize(() => {
                    let pending = updates.length;
                    let failed = false;

                    updates.forEach(u => {
                        db.run(
                            `UPDATE customers
                             SET early_pay_date = ?,
                                 normal_pay_date = ?,
                                 service_cut_date = ?
                             WHERE id = ?`,
                            [u.correctedEarly, u.correctedNormal, u.correctedCut, u.id],
                            (updateErr) => {
                                if (failed) return;
                                if (updateErr) {
                                    failed = true;
                                    return reject(updateErr);
                                }
                                pending -= 1;
                                if (pending === 0) resolve();
                            }
                        );
                    });
                });
            }
        );
    });
}

/**
 * Inicializa la base de datos y crea la tabla de clientes si no existe.
 */
function initDB() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Tabla de Clientes
            db.run(`
                CREATE TABLE IF NOT EXISTS customers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subscriber_number TEXT,
                    name TEXT NOT NULL,
                    phone TEXT NOT NULL,
                    early_pay_date TEXT,
                    normal_pay_date TEXT,
                    service_cut_date TEXT,
                    early_pay_amount REAL,
                    normal_pay_amount REAL,
                    service_cut_amount REAL,
                    status TEXT DEFAULT 'active',
                    preferred_payment_day INTEGER,
                    send_notifications INTEGER DEFAULT 1,
                    created_at TEXT
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS packages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    early_pay_amount REAL NOT NULL,
                    normal_pay_amount REAL NOT NULL,
                    service_cut_amount REAL NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Tabla de Logs de Mensajes
            db.run(`
                CREATE TABLE IF NOT EXISTS message_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER,
                    customer_name TEXT,
                    phone TEXT,
                    message TEXT,
                    type TEXT,
                    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    status TEXT,
                    FOREIGN KEY(customer_id) REFERENCES customers(id)
                )
            `);

            // Tabla de Configuración (Plantillas de Mensajes)
            db.run(`
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            `);

            // Tabla de Pagos Realizados
            db.run(`
                CREATE TABLE IF NOT EXISTS payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER,
                    customer_name TEXT,
                    amount REAL,
                    payment_type TEXT,
                    payment_date TEXT,
                    billing_cycle TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(customer_id) REFERENCES customers(id)
                )
            `, (err) => {
                if (err) reject(err);
                else {
                    Promise.all([
                        ensureColumn('customers', 'preferred_payment_day', 'INTEGER'),
                        ensureColumn('customers', 'package_id', 'INTEGER'),
                        ensureColumn('customers', 'send_notifications', 'INTEGER DEFAULT 1'),
                        ensureColumn('payments', 'billing_cycle', 'TEXT')
                    ])
                        .then(() => backfillPreferredPaymentDay())
                        .then(() => normalizeCustomerDates())
                        .then(() => {
                            const defaults = [
                                ['template_pronto_pago', 'Hola {name}, recordatorio de PRONTO PAGO. ¡Aprovecha el descuento pagando hoy! Tu monto a pagar es: {amount}'],
                                ['template_pago_normal', 'Hola {name}, hoy es tu fecha límite de PAGO NORMAL. Evita recargos. Tu monto a pagar es: {amount}'],
                                ['template_corte_servicio', 'AVISO IMPORTANTE: Hola {name}, hoy es la fecha de CORTE DE SERVICIO. Por favor, realiza tu pago para evitar la suspensión. Tu monto a pagar es: {amount}'],
                                ['template_thank_you', '¡Muchas gracias {name}! Hemos recibido tu pago de ${amount} correspondiente a {type}. Saludos.'],
                                ['enable_thank_you', 'false']
                            ];
                            
                            const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
                            defaults.forEach(d => stmt.run(d));
                            stmt.finalize();

                            console.log('Base de datos y tablas inicializadas correctamente.');
                            resolve();
                        })
                        .catch(reject);
                }
            });
        });
    });
}

/**
 * Funciones de Configuración
 */
const SettingsModel = {
    get: (key) => {
        return new Promise((resolve, reject) => {
            db.get(`SELECT value FROM settings WHERE key = ?`, [key], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.value : null);
            });
        });
    },
    getAll: () => {
        return new Promise((resolve, reject) => {
            db.all(`SELECT * FROM settings`, [], (err, rows) => {
                if (err) reject(err);
                else {
                    const settings = {};
                    rows.forEach(r => settings[r.key] = r.value);
                    resolve(settings);
                }
            });
        });
    },
    update: (key, value) => {
        return new Promise((resolve, reject) => {
            db.run(`UPDATE settings SET value = ? WHERE key = ?`, [value, key], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};

/**
 * Funciones de Log de Mensajes
 */
const CustomerModel = {
    // Altas
    create: (customer) => {
        return new Promise((resolve, reject) => {
            const { subscriber_number, name, phone, early_pay_date, normal_pay_date, service_cut_date, early_pay_amount, normal_pay_amount, service_cut_amount, preferred_payment_day, package_id, send_notifications } = customer;
            const createdAt = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            
            const preferredPaymentDay = Number.isFinite(preferred_payment_day) ? preferred_payment_day : parseInt(early_pay_date.split('-')[2], 10);
            const sendNotifications = send_notifications === 0 ? 0 : 1;

            db.run(
                `INSERT INTO customers (subscriber_number, name, phone, early_pay_date, normal_pay_date, service_cut_date, early_pay_amount, normal_pay_amount, service_cut_amount, preferred_payment_day, package_id, send_notifications, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [subscriber_number, name, phone, early_pay_date, normal_pay_date, service_cut_date, early_pay_amount, normal_pay_amount, service_cut_amount, preferredPaymentDay, package_id ?? null, sendNotifications, createdAt],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },

    // Bajas
    delete: (id) => {
        return new Promise((resolve, reject) => {
            db.run(`DELETE FROM customers WHERE id = ?`, [id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },

    // Cambios (Actualización)
    update: (id, data) => {
        return new Promise((resolve, reject) => {
            const keys = Object.keys(data);
            const fields = keys.map(key => `${key} = ?`).join(', ');
            const values = [...Object.values(data), id];
            
            console.log(`Ejecutando SQL Update para ID ${id}:`, `UPDATE customers SET ${fields} WHERE id = ?`, values);
            
            db.run(`UPDATE customers SET ${fields} WHERE id = ?`, values, (err) => {
                if (err) {
                    console.error('Error en db.run update:', err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    },

    // Lectura (Todos o por ID)
    getAll: () => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT customers.*, packages.name AS package_name
                 FROM customers
                 LEFT JOIN packages ON packages.id = customers.package_id`,
                [],
                (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
                }
            );
        });
    },

    getById: (id) => {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT customers.*, packages.name AS package_name
                 FROM customers
                 LEFT JOIN packages ON packages.id = customers.package_id
                 WHERE customers.id = ?`,
                [id],
                (err, row) => {
                if (err) reject(err);
                else resolve(row);
                }
            );
        });
    }
};

/**
 * Funciones de Log de Mensajes
 */
const LogModel = {
    add: (log) => {
        return new Promise((resolve, reject) => {
            const { customer_id, customer_name, phone, message, type, status } = log;
            db.run(
                `INSERT INTO message_logs (customer_id, customer_name, phone, message, type, status) VALUES (?, ?, ?, ?, ?, ?)`,
                [customer_id, customer_name, phone, message, type, status],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },
    getAll: () => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT message_logs.*, packages.name AS package_name
                 FROM message_logs
                 LEFT JOIN customers ON customers.id = message_logs.customer_id
                 LEFT JOIN packages ON packages.id = customers.package_id
                 ORDER BY message_logs.sent_at DESC`,
                [],
                (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
                }
            );
        });
    },
    clearAll: () => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run(`DELETE FROM message_logs`, [], (err) => {
                    if (err) return reject(err);
                    db.run(`DELETE FROM sqlite_sequence WHERE name = 'message_logs'`, [], (seqErr) => {
                        if (seqErr && !/no such table: sqlite_sequence/i.test(seqErr.message || '')) return reject(seqErr);
                        resolve();
                    });
                });
            });
        });
    }
};

/**
 * Funciones de Pagos
 */
const PaymentModel = {
    add: (payment) => {
        return new Promise((resolve, reject) => {
            const { customer_id, customer_name, amount, payment_type, payment_date, billing_cycle } = payment;
            db.run(
                `INSERT INTO payments (customer_id, customer_name, amount, payment_type, payment_date, billing_cycle) VALUES (?, ?, ?, ?, ?, ?)`,
                [customer_id, customer_name, amount, payment_type, payment_date, billing_cycle],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },
    getAll: (startDate, endDate) => {
        return new Promise((resolve, reject) => {
            let query = `SELECT * FROM payments`;
            let params = [];
            if (startDate && endDate) {
                query += ` WHERE payment_date BETWEEN ? AND ?`;
                params = [startDate, endDate];
            }
            query += ` ORDER BY payment_date DESC`;
            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },
    getMonthlyPaidCustomerIds: (month) => {
        // month format 'YYYY-MM'
        return new Promise((resolve, reject) => {
            db.all(`SELECT DISTINCT customer_id FROM payments WHERE payment_date LIKE ?`, [`${month}%`], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(r => r.customer_id));
            });
        });
    },
    hasPaidForCycle: (customerId, billingCycle) => {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT 1 AS paid FROM payments WHERE customer_id = ? AND billing_cycle = ? LIMIT 1`,
                [customerId, billingCycle],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                }
            );
        });
    },
    getById: (id) => {
        return new Promise((resolve, reject) => {
            db.get(`SELECT * FROM payments WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },
    updateAmount: (id, amount) => {
        return new Promise((resolve, reject) => {
            db.run(`UPDATE payments SET amount = ? WHERE id = ?`, [amount, id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },
    delete: (id) => {
        return new Promise((resolve, reject) => {
            db.run(`DELETE FROM payments WHERE id = ?`, [id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};

const PackageModel = {
    create: (pkg) => {
        return new Promise((resolve, reject) => {
            const { name, early_pay_amount, normal_pay_amount, service_cut_amount } = pkg;
            db.run(
                `INSERT INTO packages (name, early_pay_amount, normal_pay_amount, service_cut_amount) VALUES (?, ?, ?, ?)`,
                [name, early_pay_amount, normal_pay_amount, service_cut_amount],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },
    getAll: () => {
        return new Promise((resolve, reject) => {
            db.all(`SELECT * FROM packages ORDER BY name ASC`, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },
    getById: (id) => {
        return new Promise((resolve, reject) => {
            db.get(`SELECT * FROM packages WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },
    update: (id, data) => {
        return new Promise((resolve, reject) => {
            const keys = Object.keys(data);
            const fields = keys.map(key => `${key} = ?`).join(', ');
            const values = [...Object.values(data), id];
            db.run(`UPDATE packages SET ${fields} WHERE id = ?`, values, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },
    delete: (id) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run(`UPDATE customers SET package_id = NULL WHERE package_id = ?`, [id], (err) => {
                    if (err) return reject(err);
                    db.run(`DELETE FROM packages WHERE id = ?`, [id], (err2) => {
                        if (err2) return reject(err2);
                        resolve();
                    });
                });
            });
        });
    }
};

module.exports = { initDB, CustomerModel, LogModel, SettingsModel, PaymentModel, PackageModel };
