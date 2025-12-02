module.exports = {
    flowFile: "flows.json",
    userDir: "/var/lib/node-red/.node-red",
    uiPort: process.env.PORT || 1880,

    // Serve React GUI at /gui path
    httpStatic: '/usr/lib/node-red/gui',
    httpStaticRoot: '/gui',

    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,

    functionGlobalContext: {
        // Enable global context
    },

    exportGlobalContextKeys: false,

    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: false
        }
    },

    editorTheme: {
        projects: {
            enabled: false
        }
    }
};
