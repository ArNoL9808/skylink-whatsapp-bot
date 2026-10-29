require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const { RouterOSClient } = require('routeros-client');

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

// Configuración de mapa de routers (Mapeado por mikrotik_id de tu tabla 'locations' o servicios)
const ROUTERS_CONFIG = {
    // Puedes agregar aquí los UUIDs de tus mikrotik_id reales y sus respectivas IPs/credenciales
    'default': {
        host: process.env.MIKROTIK_HOST || '192.168.8.1',
        user: process.env.MIKROTIK_USER || 'admin_api',
        password: process.env.MIKROTIK_PASSWORD || 'tu_password_seguro',
        port: parseInt(process.env.MIKROTIK_PORT || '8728')
    }
};

// Diccionario de Mapeo de Planes y Parámetros de Burst para MikroTik
const PLANS_CONFIG = {
    'basic gold': {
        maxLimit: '5M/5M',
        burstLimit: '10M/10M',
        burstThreshold: '3M/3M',
        burstTime: '8s/8s',
        queue: 'pcq-upload-default/pcq-download-default'
    },
    'advanced': {
        maxLimit: '10M/10M',
        burstLimit: '18M/18M',
        burstThreshold: '7M/7M',
        burstTime: '8s/8s',
        queue: 'pcq-upload-default/pcq-download-default'
    },
    'advance gold': {
        maxLimit: '10M/10M',
        burstLimit: '18M/18M',
        burstThreshold: '7M/7M',
        burstTime: '8s/8s',
        queue: 'pcq-upload-default/pcq-download-default'
    },
    'premium': {
        maxLimit: '20M/20M',
        burstLimit: '35M/35M',
        burstThreshold: '14M/14M',
        burstTime: '8s/8s',
        queue: 'pcq-upload-default/pcq-download-default'
    },
    'premium gold': {
        maxLimit: '20M/20M',
        burstLimit: '35M/35M',
        burstThreshold: '14M/14M',
        burstTime: '8s/8s',
        queue: 'pcq-upload-default/pcq-download-default'
    },
    'suspendido': {
        maxLimit: '32k/32k',
        burstLimit: '0/0',
        burstThreshold: '0/0',
        burstTime: '0s/0s',
        queue: 'default'
    }
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
// 🛜 MÓDULO DE CONTROL MIKROTIK (POR IP Y MIKROTIK_ID)
// =====================================================================
async function aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, tipoAccion, nombrePlan) {
    if (!ipCliente) {
        console.log(`[MikroTik] ⚠️ No se puede aplicar cambios: El cliente no tiene IP registrada.`);
        return false;
    }

    // Seleccionar el router correspondiente o usar el default
    const targetRouter = ROUTERS_CONFIG[mikrotikId] || ROUTERS_CONFIG['default'];
    const client = new RouterOSClient(targetRouter);

    try {
        const api = await client.connect();
        
        // Buscar la Simple Queue cuyo target contenga la IP del cliente de forma exacta
        const queues = await api.menu('/queue/simple').get();
        const queueCliente = queues.find(q => q.target && q.target.includes(ipCliente));
        
        if (!queueCliente) {
            console.log(`[MikroTik] ⚠️ No se encontró ninguna Simple Queue con la IP: ${ipCliente} en el router ID: ${mikrotikId}`);
            await client.close();
            return false;
        }

        const queueId = queueCliente['.id'];
        let configPlan;
        let comentario;

        if (tipoAccion === 'suspender') {
            configPlan = PLANS_CONFIG['suspendido'];
            comentario = `SUSPENDIDO - IP: ${ipCliente}`;
        } else {
            const planKey = Object.keys(PLANS_CONFIG).find(p => nombrePlan.toLowerCase().includes(p)) || 'advance gold';
            configPlan = PLANS_CONFIG[planKey];
            comentario = `Plan Activo: ${nombrePlan} (${ipCliente})`;
        }

        // Aplicar la actualización en la Simple Queue de RouterOS vía API
        await api.menu('/queue/simple').update(queueId, {
            'max-limit': configPlan.maxLimit,
            'burst-limit': configPlan.burstLimit,
            'burst-threshold': configPlan.burstThreshold,
            'burst-time': configPlan.burstTime,
            'queue': configPlan.queue,
            comment: comentario
        });

        console.log(`[MikroTik] ✅ Éxito: IP ${ipCliente} actualizada a perfil [${tipoAccion.toUpperCase()}] (${comentario})`);
        await client.close();
        return true;
    } catch (error) {
        console.error(`[MikroTik] ❌ Error al modificar IP ${ipCliente} en MikroTik:`, error.message);
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
// ⚡ SUPABASE REALTIME (ESCUCHA AUTOMÁTICA DE CAMBIOS EN VIVO)
// =====================================================================
function iniciarEscuchasRealtimeSupabase() {
    console.log('[SUPABASE REALTIME] Activando escuchas en tiempo real...');

    // 1. Escuchar cambios en internet_services (Para automatizar cortes / reconexiones en MikroTik por IP)
    supabase
      .channel('service-changes-channel')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'internet_services' },
        async (payload) => {
          const nuevoServicio = payload.new;
          const servicioAnterior = payload.old;

          if (nuevoServicio.is_suspended !== servicioAnterior.is_suspended || nuevoServicio.status !== servicioAnterior.status) {
              const { data: plan } = await supabase.from('plans').select('name').eq('id', nuevoServicio.plan_id).single();
              
              const ipCliente = nuevoServicio.ip;
              const mikrotikId = nuevoServicio.mikrotik_id;
              const planName = plan?.name || 'advance gold';

              if (ipCliente) {
                  if (nuevoServicio.is_suspended || nuevoServicio.status === 'suspended' || nuevoServicio.status === 'cut') {
                      console.log(`[REALTIME] Detectada suspensión/corte para IP: ${ipCliente}`);
                      await aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, 'suspender', planName);
                  } else if (!nuevoServicio.is_suspended && nuevoServicio.status === 'active') {
                      console.log(`[REALTIME] Detectada reconexión/pago para IP: ${ipCliente}`);
                      await aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, 'reconectar', planName);
                  }
              }
          }
        }
      )
      .subscribe();

    // 2. Escuchar la cola de WhatsApp (whatsapp_logs) para envío de comprobantes instantáneos
    supabase
      .channel('whatsapp-queue-channel')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'whatsapp_logs' },
        async (payload) => {
          const logItem = payload.new;
          if (logItem.status === 'pending') {
              console.log(`[REALTIME] Nuevo mensaje pendiente detectado (ID: ${logItem.id})`);
              procesarMensajeIndividual(logItem);
          }
        }
      )
      .subscribe();
}

// =====================================================================
// ⏰ PROGRAMACIÓN DE TAREAS (CRON & INTERVAL)
// =====================================================================
cron.schedule('0 9 * * *', () => {
    console.log(`[${new Date().toLocaleString()}] Ejecutando revisión diaria automática de cobros...`);
    verificarYNotificarClientes();
});

setInterval(() => {
    procesarMensajesPendientes();
}, 30000);

// =====================================================================
// 📬 PROCESAR COLA DE MENSAJES PENDIENTES
// =====================================================================
async function procesarMensajesPendientes() {
    const { data: pendientes, error } = await supabase
        .from('whatsapp_logs')
        .select('*')
        .eq('status', 'pending');

    if (error || !pendientes || pendientes.length === 0) return;

    console.log(`\n[BOT PENDIENTES] Se encontraron ${pendientes.length} mensaje(s) por enviar.`);

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

    if (!telefono) {
        await supabase.from('whatsapp_logs').update({ status: 'no_phone' }).eq('id', logItem.id);
        return;
    }

    const formattedNumber = formatearNumeroWhatsApp(telefono);

    try {
        const chatId = await client.getNumberId(formattedNumber);
        
        if (!chatId) {
            await supabase.from('whatsapp_logs').update({ status: 'no_whatsapp' }).eq('id', logItem.id);
            return;
        }

        await client.sendMessage(chatId._serialized, mensajeTexto);
        console.log(`[ENVIADO] Mensaje [${logItem.message_type?.toUpperCase()}] enviado a ${clienteNombre} (${telefono})`);

        await supabase
            .from('whatsapp_logs')
            .update({ 
                status: 'sent',
                sent_at: new Date().toISOString()
            })
            .eq('id', logItem.id);

        await esperar(3000);

    } catch (err) {
        console.error(`[ERROR] Falló el envío para ${clienteNombre}:`, err.message);
    }
}

// =====================================================================
// 🔍 MOTOR PRINCIPAL: EVALUAR CLIENTES Y RECORDATORIOS/CORTES
// =====================================================================
async function verificarYNotificarClientes() {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    console.log(`\n========================================`);
    console.log(`[PRODUCCIÓN] Fecha evaluada como "Hoy": ${hoy.toISOString().split('T')[0]}`);
    console.log(`========================================\n`);

    const { data: locationsData } = await supabase.from('locations').select('*');
    const locationsMap = {};
    if (locationsData) {
        locationsData.forEach(loc => {
            locationsMap[loc.mikrotik_id] = {
                tolerance_days: loc.tolerance_days ?? 7,
                name: loc.name
            };
        });
    }

    const { data: servicios, error } = await supabase
        .from('internet_services')
        .select(`
            id,
            ip,
            mikrotik_id,
            next_due_date,
            status,
            is_suspended,
            user_id,
            plans (
                name,
                price
            ),
            profiles!inner (
                firstname,
                lastname,
                phone
            )
        `);

    if (error) {
        console.error('Error al consultar Supabase:', error);
        return;
    }

    if (!servicios || servicios.length === 0) return;

    let contadorAcciones = 0;

    for (const servicio of servicios) {
        if (!servicio.next_due_date || !servicio.profiles.phone) continue;

        const firstname = servicio.profiles.firstname;
        const telefono = servicio.profiles.phone;
        const monthlyPrice = parseFloat(servicio.plans?.price || 0);
        const planName = servicio.plans?.name || 'advance gold';
        const billingPeriod = servicio.next_due_date;
        const ipCliente = servicio.ip;
        const mikrotikId = servicio.mikrotik_id;

        const locInfo = locationsMap[mikrotikId] || { tolerance_days: 7 };
        const diasTolerancia = locInfo.tolerance_days;

        const dueDate = new Date(servicio.next_due_date + 'T00:00:00');
        const diffTime = hoy - dueDate;
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        const footer = "\n\n_Este mensaje es automático, no es necesario responder a menos de que tenga dudas referentes al pago._";

        let messageType = null;
        let mensajeTexto = "";
        
        // 1. Día exacto de vencimiento -> Recordatorio
        if (diffDays === 0) {
            messageType = 'recordatorio';
            mensajeTexto = `*¡Recordatorio de Pago SkyLink!* 📡\n\n` +
                           `Hola *${firstname}*, ya puedes realizar el pago de tu mensualidad.\n\n` +
                           `*Información de pago:* \n` +
                           `💰 Monto: $${monthlyPrice}\n\n` +
                           `Recuerda pagar dentro del plazo establecido para evitar cargos extra. ¡Gracias por confiar en SkyLink!` + footer;
        } 
        // 2. Pasó tolerancia pero no más de 5 días -> Aviso de Corte
        else if (diffDays > diasTolerancia && diffDays <= (diasTolerancia + 5) && servicio.status !== 'suspended') {
            messageType = 'cortado';
            const totalWithFee = monthlyPrice + RECONNECTION_FEE;
            mensajeTexto = `*¡Pago Vencido SkyLink!* ⚠️\n\n` +
                           `Hola *${firstname}*, te recordamos que la fecha límite ha expirado.\n\n` +
                           `*Estado de cuenta:* \n` +
                           `💰 Total con recargo de reconexión: $${totalWithFee}\n\n` +
                           `Evita la suspensión definitiva de tu servicio realizando tu pago a la brevedad.` + footer;
            
            // Aplicar corte automático en MikroTik por IP
            if (ipCliente) {
                await aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, 'suspender', planName);
                await supabase.from('internet_services').update({ is_suspended: true, status: 'cut' }).eq('id', servicio.id);
            }
        } 
        // 3. Suspensión definitiva
        else if (diffDays > (diasTolerancia + 5) && servicio.status !== 'suspended') {
            messageType = 'suspendido';
            const totalWithFee = monthlyPrice + RECONNECTION_FEE;
            mensajeTexto = `*¡Aviso de Suspensión SkyLink!* 🚫\n\n` +
                           `Hola *${firstname}*, tu servicio se encuentra *suspendido* por falta de pago.\n\n` +
                           `*Detalles del adeudo:* \n` +
                           `💰 Total a pagar: $${totalWithFee}\n` +
                           `📝 Incluye: Recargo por reconexión\n\n` +
                           `Realiza tu pago para reactivar tu señal de inmediato. ¡Gracias!` + footer;
            
            if (ipCliente) {
                await aplicarCambioEnMikroTikPorIP(ipCliente, mikrotikId, 'suspender', planName);
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
            console.log(`[COBRO AUTOMÁTICO] Mensaje [${messageType}] enviado a ${firstname} (${telefono})`);

            await esperar(5000);
        }
    }

    console.log(`\n========================================`);
    console.log(` Escaneo diario finalizado. Acciones: ${contadorAcciones}`);
    console.log(`========================================\n`);
}