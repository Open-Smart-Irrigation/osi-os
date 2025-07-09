module.exports = {
    flowFile: "flows.json",
    uiPort: process.env.PORT || 1880,
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
    },
    
    // Disable authentication for local use
    // For production, enable authentication
    adminAuth: {
        type: "credentials",
        users: [{
            username: "admin",
            password: "$2a$08$zZWtXTja0fB1pzD4sHCMyOCMYz2Z6dNbM6tl8sJogENOMcxWV9DN.",
            permissions: "*"
        }]
    }
};
