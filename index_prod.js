require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// 1. Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Faltan las credenciales de Supabase en el archivo .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Costo fijo de reconexión
const RECONNECTION_FEE = 100.00;

// 🕒 Función auxiliar para hacer pausas (en milisegundos) y evitar baneos
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =====================================================================
// 🤖 CONFIGURACIÓN DE WHATSAPP-WEB.JS
// =====================================================================
const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    console.log('\n[WHATSAPP] Escanea el siguiente código QR con tu aplicación de WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n========================================');
    console.log(' ¡Bot de WhatsApp CONECTADO y listo! 🚀');
    console.log('========================================\n');
    
    // Una vez listo WhatsApp, procesamos mensajes pendientes y escaneamos
    procesarMensajesPendientes();
    verificarYNotificarClientes();
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
// ⏰ PROGRAMACIÓN DE TAREAS (CRON & INTERVAL)
// =====================================================================

// A. Tarea Diaria (9:00 AM): Evalúa cobros y notificaciones
cron.schedule('0 9 * * *', () => {
    console.log(`[${new Date().toLocaleString()}] Ejecutando revisión diaria automática de cobros...`);
    verificarYNotificarClientes();
});

// B. Tarea Continua (Cada 30 segundos): Revisa cola de comprobantes / mensajes instantáneos
setInterval(() => {
    procesarMensajesPendientes();
}, 30000);


// =====================================================================
// 📬 PROCESAR COLA DE MENSAJES PENDIENTES (Comprobantes de pago, etc.)
// =====================================================================
async function procesarMensajesPendientes() {
    const { data: pendientes, error } = await supabase
        .from('whatsapp_logs')
        .select(`
            id,
            internet_service_id,
            message_type,
            billing_period,
            payload,
            user_id,
            profiles (
                firstname,
                phone
            )
        `)
        .eq('status', 'pending');

    if (error || !pendientes || pendientes.length === 0) {
        return; 
    }

    console.log(`\n[BOT INSTANTÁNEO] Se encontraron ${pendientes.length} mensaje(s) pendiente(s). Procesando...`);

    for (const logItem of pendientes) {
        const telefono = logItem.profiles?.phone;
        const mensajeTexto = logItem.payload;
        const clienteNombre = logItem.profiles?.firstname || 'Cliente';
        const messageType = logItem.message_type;

        if (!telefono) {
            console.log(`[AVISO] El cliente ${clienteNombre} no tiene número de teléfono registrado.`);
            await supabase.from('whatsapp_logs').update({ status: 'no_phone' }).eq('id', logItem.id);
            continue;
        }

        const cleanPhone = telefono.replace(/\D/g, '');
        const formattedNumber = `52${cleanPhone}@c.us`;

        try {
            // Validación del número en WhatsApp
            const chatId = await client.getNumberId(formattedNumber);
            
            if (!chatId) {
                console.log(`[AVISO] El número de ${clienteNombre} (${telefono}) no tiene WhatsApp o no es válido.`);
                await supabase
                    .from('whatsapp_logs')
                    .update({ status: 'no_whatsapp' })
                    .eq('id', logItem.id);
                continue;
            }

            // Envío del mensaje
            await client.sendMessage(chatId._serialized, mensajeTexto);
            console.log(`[ENVIADO] Mensaje [${messageType.toUpperCase()}] enviado exitosamente a ${clienteNombre} (${telefono})`);

            // Actualizar estatus a 'sent'
            await supabase
                .from('whatsapp_logs')
                .update({ status: 'sent' })
                .eq('id', logItem.id);

            // Pausa de seguridad
            await esperar(3000);

        } catch (err) {
            console.error(`[ERROR] Falló el envío para ${clienteNombre}:`, err.message);
        }
    }
}

// =====================================================================
// 🔍 MOTOR PRINCIPAL: EVALUAR CLIENTES Y ENVIAR RECORDATORIOS/CORTES
// =====================================================================
async function verificarYNotificarClientes() {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    console.log(`\n========================================`);
    console.log(`[PRODUCCIÓN] Fecha real evaluada como "Hoy": ${hoy.toISOString().split('T')[0]}`);
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

    // Consultamos TODOS los servicios activos, cortados o suspendidos
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
        const billingPeriod = servicio.next_due_date;

        const locInfo = locationsMap[servicio.mikrotik_id] || { tolerance_days: 7 };
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
        // 2. Pasó tolerancia pero no más de 5 días -> Aviso de Corte por falta de pago
        else if (diffDays > diasTolerancia && diffDays <= (diasTolerancia + 5) && servicio.status !== 'suspended') {
            messageType = 'cortado';
            const totalWithFee = monthlyPrice + RECONNECTION_FEE;
            mensajeTexto = `*¡Pago Vencido SkyLink!* ⚠️\n\n` +
                           `Hola *${firstname}*, te recordamos que la fecha límite ha expirado.\n\n` +
                           `*Estado de cuenta:* \n` +
                           `💰 Total con recargo de reconexión: $${totalWithFee}\n\n` +
                           `Evita la suspensión definitiva de tu servicio realizando tu pago a la brevedad.` + footer;
        } 
        // 3. Pasaron más de 5 días adicionales -> Aviso de Suspensión definitiva
        else if (diffDays > (diasTolerancia + 5) && servicio.status !== 'suspended') {
            messageType = 'suspendido';
            const totalWithFee = monthlyPrice + RECONNECTION_FEE;
            mensajeTexto = `*¡Aviso de Suspensión SkyLink!* 🚫\n\n` +
                           `Hola *${firstname}*, tu servicio se encuentra *suspendido* por falta de pago.\n\n` +
                           `*Detalles del adeudo:* \n` +
                           `💰 Total a pagar: $${totalWithFee}\n` +
                           `📝 Incluye: Recargo por reconexión\n\n` +
                           `Realiza tu pago para reactivar tu señal de inmediato. ¡Gracias!` + footer;
        }

        if (messageType) {
            // Verificar si ya le enviamos un mensaje del mismo tipo para este periodo
            const { data: logExistente } = await supabase
                .from('whatsapp_logs')
                .select('id')
                .eq('internet_service_id', servicio.id)
                .eq('message_type', messageType)
                .eq('billing_period', billingPeriod)
                .limit(1);

            if (logExistente && logExistente.length > 0) continue; 

            // Validar número en WhatsApp
            const cleanPhone = telefono.replace(/\D/g, '');
            const formattedNumber = `52${cleanPhone}@c.us`;
            const chatId = await client.getNumberId(formattedNumber);

            if (!chatId) {
                console.log(`[AVISO] El cliente ${firstname} (${telefono}) no tiene WhatsApp activo. Se omite.`);
                continue;
            }

            // Registrar log
            await supabase.from('whatsapp_logs').insert([{
                user_id: servicio.user_id,
                internet_service_id: servicio.id,
                message_type: messageType,
                billing_period: billingPeriod,
                status: 'sent',
                payload: mensajeTexto
            }]);

            contadorAcciones++;

            // Enviar mensaje
            await client.sendMessage(chatId._serialized, mensajeTexto);
            console.log(`[COBRO AUTOMÁTICO] Mensaje [${messageType}] enviado a ${firstname} (${telefono})`);

            // Pausa de seguridad anti-spam
            await esperar(5000);
        }
    }

    console.log(`\n========================================`);
    console.log(` Escaneo diario finalizado. Acciones ejecutadas: ${contadorAcciones}`);
    console.log(`========================================\n`);
}