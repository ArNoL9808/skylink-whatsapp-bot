require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// 1. Configuración de Supabase (Usando Service Role Key para privilegios de backend)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Faltan las credenciales de Supabase en el archivo .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
});

// Costo fijo de reconexión
const RECONNECTION_FEE = 100.00;

// Configuración de mapa de routers
const ROUTERS_CONFIG = {
    'default': {
        host: process.env.MIKROTIK_HOST || '192.168.8.1',
        user: process.env.MIKROTIK_USER || 'admin_api',
        password: process.env.MIKROTIK_PASSWORD || 'tu_password_seguro',
        port: parseInt(process.env.MIKROTIK_PORT || '8728')
    }
};

// Configuración estática única para el estado de suspensión (corte)
const SUSPEND_CONFIG = {
    maxLimit: '32k/32k',
    burstLimit: '0/0',
    burstThreshold: '0/0',
    burstTime: '0s/0s',
    queue: 'default'
};

// 🕒 Función auxiliar para hacer pausas (en milisegundos)
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 📱 Función inteligente para formatear el número para WhatsApp según el país
function formatearNumeroWhatsApp(telefono) {
    if (!telefono) return null;
    let cleanPhone = telefono.replace(/\D/g, '');

    if (cleanPhone.length === 10) {
        return `52${cleanPhone}@c.us`;
    }
    if (cleanPhone.length === 11 && cleanPhone.startsWith('1')) {
        return `${cleanPhone}@c.us`;
    }
    if (cleanPhone.length > 10) {
        return `${cleanPhone}@c.us`;
    }
    return `${cleanPhone}@c.us`;
}

// =====================================================================
// 🛜 MÓDULO DE CONTROL MIKROTIK (VÍA REST API CONSULTANDO LA BD)
// =====================================================================
async function aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, tipoAccion, planId) {
    if (!ipCliente) {
        console.log(`[MikroTik] ⚠️ No se puede aplicar cambios: El cliente no tiene IP registrada.`);
        return false;
    }

    const targetRouter = ROUTERS_CONFIG[mikrotikId] || ROUTERS_CONFIG['default'];
    const protocol = targetRouter.port === 8729 ? 'https' : 'http';
    const host = targetRouter.host;
    const auth = Buffer.from(`${targetRouter.user}:${targetRouter.password}`).toString('base64');
    const baseUrl = `${protocol}://${host}/rest`;

    try {
        let configPlan;

        // Si la acción es suspender, usamos la config estática de corte
        if (tipoAccion === 'suspender') {
            configPlan = SUSPEND_CONFIG;
        } else {
            // Si es activar, CONSULTAMOS DIRECTAMENTE LA TABLA 'plans' EN SUPABASE 🚀
            const { data: planData, error: planError } = await supabase
                .from('plans')
                .select('max_limit, burst_limit, burst_threshold, burst_time, queue_type, name')
                .eq('id', planId)
                .single();

            if (planError || !planData) {
                console.error(`[MikroTik] ❌ No se encontró el plan con ID ${planId} en la BD. Usando respaldo por defecto.`);
                // Respaldo de seguridad en caso de que el plan no tenga los campos llenos
                configPlan = {
                    maxLimit: '10M/10M',
                    burstLimit: '18M/18M',
                    burstThreshold: '7M/7M',
                    burstTime: '8s/8s',
                    queue: 'pcq-upload-default/pcq-download-default'
                };
            } else {
                configPlan = {
                    maxLimit: planData.max_limit || '10M/10M',
                    burstLimit: planData.burst_limit || '18M/18M',
                    burstThreshold: planData.burst_threshold || '7M/7M',
                    burstTime: planData.burst_time || '8s/8s',
                    queue: planData.queue_type || 'pcq-upload-default/pcq-download-default'
                };
            }
        }

        console.log(`[MikroTik] Conectando vía REST API a ${host} para la IP ${ipCliente}...`);

        // 1. Obtener todas las simple queues desde la REST API de MikroTik
        const resQueues = await fetch(`${baseUrl}/queue/simple`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });

        if (!resQueues.ok) {
            console.error(`[MikroTik] ❌ Error al consultar colas en el router: ${resQueues.statusText}`);
            return false;
        }

        const queues = await resQueues.json();

        // 2. Buscar la cola que coincida con la IP del cliente en el target
        const queueCliente = queues.find(q => q.target && q.target.includes(ipCliente));

        if (!queueCliente) {
            console.log(`[MikroTik] ⚠️ No se encontró ninguna Simple Queue con la IP: ${ipCliente} en el router ${mikrotikId}`);
            return false;
        }

        const queueId = queueCliente['.id'];
        const comentario = tipoAccion === 'suspender' 
            ? `SUSPENDIDO - IP: ${ipCliente}` 
            : `Plan Activo ID: ${planId} (${ipCliente})`;

        // 3. Aplicar los cambios mediante una petición PATCH a la REST API
        const resUpdate = await fetch(`${baseUrl}/queue/simple/${queueId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                'max-limit': configPlan.maxLimit,
                'burst-limit': configPlan.burstLimit,
                'burst-threshold': configPlan.burstThreshold,
                'burst-time': configPlan.burstTime,
                'queue': configPlan.queue,
                'comment': comentario
            })
        });

        if (!resUpdate.ok) {
            const errBody = await resUpdate.text();
            console.error(`[MikroTik] ❌ Error al actualizar la cola via REST: ${errBody}`);
            return false;
        }

        console.log(`[MikroTik] ✅ Éxito REST API: IP ${ipCliente} actualizada a perfil [${tipoAccion.toUpperCase()}]`);
        return true;

    } catch (error) {
        console.error(`[MikroTik] ❌ Error crítico de red en REST API para ${ipCliente}:`, error.message);
        return false;
    }
}

// =====================================================================
// 🤖 CONFIGURACIÓN DE WHATSAPP-WEB.JS
// =====================================================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n[WHATSAPP] Escanea el siguiente código QR con tu aplicación de WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n========================================');
    console.log(' ¡Bot de WhatsApp CONECTADO y listo! 🚀');
    console.log('========================================\n');
    
    procesarMensajesPendientes();
    verificarYNotificarClientes();
    iniciarEscuchasRealtimeSupabase();
});

client.on('auth_failure', msg => {
    console.error('[WHATSAPP ERROR] Falló la autenticación:', msg);
});

client.on('disconnected', (reason) => {
    console.log('[WHATSAPP] El cliente fue desconectado:', reason);
});

// Inicializar el cliente de WhatsApp
client.initialize();

// =====================================================================
// ⚡ SUPABASE REALTIME (ESCUCHA AUTOMÁTICA BLINDADA CONTRA FALSOS POSITIVOS)
// =====================================================================
function iniciarEscuchasRealtimeSupabase() {
    console.log('[SUPABASE REALTIME] Activando escuchas en tiempo real...');

    const channel = supabase
        .channel('service-changes-channel')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'internet_services' },
            async (payload) => {
                console.log('🚨 [REALTIME DEBUG] ¡Evento recibido de Supabase!', JSON.stringify(payload, null, 2));

                const nuevoServicio = payload.new;
                const servicioAnterior = payload.old;

                // 🛡️ FILTRO DE SEGURIDAD: 
                // Verificamos estrictamente si los campos de control crítico realmente cambiaron de valor.
                const cambioSuspension = nuevoServicio.is_suspended !== servicioAnterior.is_suspended;
                const cambioEstatus = nuevoServicio.status !== servicioAnterior.status;

                // Si se actualizaron otros campos (como IP, notas, ONU, etc.) pero el estatus y la 
                // suspensión siguen siendo exactamente iguales, IGNORAMOS el evento por completo.
                if (!cambioSuspension && !cambioEstatus) {
                    console.log(`[REALTIME] ℹ️ Actualización de datos generales ignorada (IP/Notas/etc.) para el servicio ID: ${nuevoServicio.id}`);
                    return;
                }

                console.log(`[REALTIME] ⚠️ Cambio real detectado en estatus/suspensión para la IP: ${nuevoServicio.ip || 'Sin IP'}`);

                const ipCliente = nuevoServicio.ip;
                const mikrotikId = nuevoServicio.mikrotik_id || 'default';
                const planId = nuevoServicio.plan_id;
                const userId = nuevoServicio.user_id;

                let tipoAccion = null;
                let tipoMensajeWhatsApp = null;

                // Evaluamos las banderas de forma precisa
                if (nuevoServicio.is_suspended || nuevoServicio.status === 'suspended' || nuevoServicio.status === 'inactive' || nuevoServicio.status === 'cut') {
                    // Solo procedemos si el estado anterior NO estaba ya suspendido/cortado 
                    // (evita disparos dobles si Supabase manda múltiples eventos de un mismo cambio)
                    if (!servicioAnterior.is_suspended && servicioAnterior.status === 'active') {
                        console.log(`[REALTIME] 🔴 El servicio cambió a SUSPENDIDO. Aplicando corte en MikroTik...`);
                        tipoAccion = 'suspender';
                        tipoMensajeWhatsApp = 'suspendido';
                    }
                } else if (!nuevoServicio.is_suspended && nuevoServicio.status === 'active') {
                    // Solo procedemos si antes estaba suspendido o cortado
                    if (servicioAnterior.is_suspended || servicioAnterior.status === 'suspended' || servicioAnterior.status === 'cut' || servicioAnterior.status === 'inactive') {
                        console.log(`[REALTIME] 🟢 El servicio cambió a ACTIVO. Restaurando velocidad en MikroTik...`);
                        tipoAccion = 'activar';
                        tipoMensajeWhatsApp = 'activado';
                    }
                }

                if (tipoAccion) {
                    // 1. Aplicar cambios en MikroTik consultando la BD
                    await aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, tipoAccion, planId);

                    // 2. Enviar WhatsApp al cliente
                    if (userId) {
                        const { data: profileData } = await supabase
                            .from('profiles')
                            .select('firstname, phone')
                            .eq('id', userId)
                            .single();

                        if (profileData && profileData.phone) {
                            const firstname = profileData.firstname || 'Cliente';
                            const telefono = profileData.phone;
                            const footer = "\n\n_Este mensaje es automático, no es necesario responder a menos de que tenga dudas referentes al pago._";
                            
                            let mensajeTexto = "";

                            if (tipoMensajeWhatsApp === 'suspendido') {
                                mensajeTexto = `*¡Aviso de Suspensión SkyLink!* 🚫\n\n` +
                                               `Hola *${firstname}*, tu servicio de internet ha sido *suspendido* temporalmente por falta de pago.\n\n` +
                                               `Realiza tu pago para reactivar tu señal de inmediato de forma automática. ¡Gracias!` + footer;
                            } else if (tipoMensajeWhatsApp === 'activado') {
                                mensajeTexto = `*¡Servicio Reactivado SkyLink!* 🟢\n\n` +
                                               `Hola *${firstname}*, hemos detectado tu pago con éxito. Tu servicio de internet ha sido *restaurado* al 100%.\n\n` +
                                               `¡Gracias por estar al corriente con SkyLink! Que disfrutes tu conexión.` + footer;
                            }

                            const formattedNumber = formatearNumeroWhatsApp(telefono);
                            const chatId = await client.getNumberId(formattedNumber);

                            if (chatId) {
                                await client.sendMessage(chatId._serialized, mensajeTexto);
                                console.log(`[WHATSAPP REALTIME] Mensaje de [${tipoMensajeWhatsApp}] enviado a ${firstname} (${telefono})`);
                                
                                await supabase.from('whatsapp_logs').insert([{
                                    user_id: userId,
                                    internet_service_id: nuevoServicio.id,
                                    message_type: tipoMensajeWhatsApp,
                                    billing_period: nuevoServicio.next_due_date || new Date().toISOString().split('T')[0],
                                    status: 'sent',
                                    payload: mensajeTexto
                                }]);
                            }
                        }
                    }
                }
            }
        )
        .subscribe((status, err) => {
            console.log(`[SUPABASE REALTIME] Estado de la suscripción: ${status}`);
            if (err) {
                console.error('[SUPABASE REALTIME] ❌ Error en la suscripción del canal:', err);
            }
        });
}

// =====================================================================
// ⏰ PROGRAMACIÓN DE TAREAS Y COLA DE MENSAJES
// =====================================================================
cron.schedule('0 9 * * *', () => {
    console.log(`[${new Date().toLocaleString()}] Ejecutando revisión diaria automática de cobros...`);
    verificarYNotificarClientes();
});

setInterval(() => {
    procesarMensajesPendientes();
}, 30000);

async function procesarMensajesPendientes() {
    const { data: pendientes, error } = await supabase
        .from('whatsapp_logs')
        .select('*')
        .eq('status', 'pending');

    if (error || !pendientes || pendientes.length === 0) return;

    for (const logItem of pendientes) {
        await procesarMensajeIndividual(logItem);
    }
}

async function procesarMensajeIndividual(logItem) {
    let telefono = null;
    let clienteNombre = 'Cliente';

    if (logItem.user_id) {
        const { data: profileData } = await supabase
            .from('profiles')
            .select('firstname, phone')
            .eq('id', logItem.user_id)
            .single();
        
        if (profileData) {
            telefono = profileData.phone;
            clienteNombre = profileData.firstname || 'Cliente';
        }
    }

    const mensajeTexto = logItem.payload ? logItem.payload.replace(/\\n/g, '\n') : '';
    if (!telefono) return;

    const formattedNumber = formatearNumeroWhatsApp(telefono);

    try {
        const chatId = await client.getNumberId(formattedNumber);
        if (!chatId) return;

        await client.sendMessage(chatId._serialized, mensajeTexto);
        await supabase.from('whatsapp_logs').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', logItem.id);
        await esperar(3000);
    } catch (err) {
        console.error(`[ERROR] Falló el envío para ${clienteNombre}:`, err.message);
    }
}

async function verificarYNotificarClientes() {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const { data: locationsData } = await supabase.from('locations').select('*');
    const locationsMap = {};
    if (locationsData) {
        locationsData.forEach(loc => {
            locationsMap[loc.mikrotik_id] = { tolerance_days: loc.tolerance_days ?? 7 };
        });
    }

    const { data: servicios, error } = await supabase
        .from('internet_services')
        .select(`
            id,
            ip,
            mikrotik_id,
            plan_id,
            next_due_date,
            status,
            is_suspended,
            user_id,
            plans (name, price),
            profiles!inner (firstname, lastname, phone)
        `);

    if (error || !servicios) return;

    let contadorAcciones = 0;

    for (const servicio of servicios) {
        if (!servicio.next_due_date || !servicio.profiles.phone) continue;

        const firstname = servicio.profiles.firstname;
        const telefono = servicio.profiles.phone;
        const monthlyPrice = parseFloat(servicio.plans?.price || 0);
        const planId = servicio.plan_id;
        const billingPeriod = servicio.next_due_date;
        const ipCliente = servicio.ip;
        const mikrotikId = servicio.mikrotik_id;

        const locInfo = locationsMap[mikrotikId] || { tolerance_days: 7 };
        const diasTolerancia = locInfo.tolerance_days;

        const dueDate = new Date(servicio.next_due_date + 'T00:00:00');
        const diffDays = Math.floor((hoy - dueDate) / (1000 * 60 * 60 * 24));
        const footer = "\n\n_Este mensaje es automático, no es necesario responder a menos de que tenga dudas referentes al pago._";

        let messageType = null;
        let mensajeTexto = "";
        
        if (diffDays === 0) {
            messageType = 'recordatorio';
            mensajeTexto = `*¡Recordatorio de Pago SkyLink!* 📡\n\nHola *${firstname}*, ya puedes realizar el pago de tu mensualidad.\n\n💰 Monto: $${monthlyPrice}\n\n¡Gracias por confiar en SkyLink!` + footer;
        } 
        else if (diffDays > diasTolerancia && diffDays <= (diasTolerancia + 5) && servicio.status !== 'suspended') {
            messageType = 'cortado';
            const totalWithFee = monthlyPrice + RECONNECTION_FEE;
            mensajeTexto = `*¡Pago Vencido SkyLink!* ⚠️\n\nHola *${firstname}*, tu fecha límite ha expirado.\n\n💰 Total con recargo: $${totalWithFee}\n\nEvita la suspensión realizando tu pago.` + footer;
            
            if (ipCliente) {
                await aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, 'suspender', planId);
                await supabase.from('internet_services').update({ is_suspended: true, status: 'cut' }).eq('id', servicio.id);
            }
        } 
        else if (diffDays > (diasTolerancia + 5) && servicio.status !== 'suspended') {
            messageType = 'suspendido';
            const totalWithFee = monthlyPrice + RECONNECTION_FEE;
            mensajeTexto = `*¡Aviso de Suspensión SkyLink!* 🚫\n\nHola *${firstname}*, tu servicio se encuentra *suspendido* por falta de pago.\n\n💰 Total a pagar: $${totalWithFee}` + footer;
            
            if (ipCliente) {
                await aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, 'suspender', planId);
                await supabase.from('internet_services').update({ is_suspended: true, status: 'suspended' }).eq('id', servicio.id);
            }
        }

        if (messageType) {
            const { data: logExistente } = await supabase
                .from('whatsapp_logs')
                .select('id')
                .eq('internet_service_id', servicio.id)
                .eq('message_type', messageType)
                .eq('billing_period', billingPeriod)
                .limit(1);

            if (logExistente && logExistente.length > 0) continue; 

            const formattedNumber = formatearNumeroWhatsApp(telefono);
            const chatId = await client.getNumberId(formattedNumber);
            if (!chatId) continue;

            await supabase.from('whatsapp_logs').insert([{
                user_id: servicio.user_id,
                internet_service_id: servicio.id,
                message_type: messageType,
                billing_period: billingPeriod,
                status: 'sent',
                payload: mensajeTexto
            }]);

            contadorAcciones++;
            await client.sendMessage(chatId._serialized, mensajeTexto);
            await esperar(5000);
        }
    }
}