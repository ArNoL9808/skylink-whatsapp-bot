require('dotenv').config();
const { RouterOSClient } = require('routeros-client');

const connectionConfig = {
    host: process.env.MIKROTIK_HOST || '192.168.8.1',
    user: process.env.MIKROTIK_USER || 'admin_api',
    password: process.env.MIKROTIK_PASSWORD || 'tu_password_seguro',
    port: parseInt(process.env.MIKROTIK_PORT || '8728')
};

async function probarConexion() {
    console.log(`[TEST] Intentando conectar a MikroTik en ${connectionConfig.host}:${connectionConfig.port} con usuario '${connectionConfig.user}'...`);
    
    const client = new RouterOSClient(connectionConfig);

    try {
        const api = await client.connect();
        console.log('[TEST] 🎉 ¡CONEXIÓN EXITOSA CON MIKROTIK!');

        // Consultar las simple queues actuales para verificar permisos
        const queues = await api.menu('/queue/simple').get();
        console.log(`[TEST] Se encontraron ${queues.length} colas simples (Simple Queues) en el router.`);
        
        if (queues.length > 0) {
            console.log('[TEST] Ejemplo de la primera cola encontrada:');
            console.log(` - Nombre/Target: ${queues[0].name || queues[0].target}`);
            console.log(` - Max Limit: ${queues[0]['max-limit'] || 'No definido'}`);
        }

        await client.close();
        console.log('[TEST] Conexión cerrada correctamente. ¡Todo listo!');
    } catch (error) {
        console.error('[TEST] ❌ ERROR DE CONEXIÓN CON MIKROTIK:');
        console.error(error.message);
        console.log('\nSugerencias:');
        console.log('1. Revisa que el usuario de la API tenga permisos correctos (grupo full o api).');
        console.log('2. Verifica que el puerto 8728 esté abierto en el IP / Services de MikroTik.');
        console.log('3. Comprueba que la IP y contraseña en el .env sean correctas.');
    }
}

probarConexion();