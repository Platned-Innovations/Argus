// Argus on Azure: App Service (Linux, container) + Key Vault + PostgreSQL Flexible Server or Cosmos DB for MongoDB (vCore)
// + Log Analytics. Deploy into an existing resource group:
//
//   az deployment group create -g argus-rg -f deploy/azure/main.bicep -p @deploy/azure/main.parameters.json
//
// Secrets (master key, database password) are passed as secure parameters, stored in Key Vault, and reach the app
// only as Key Vault references resolved by the web app's managed identity.

targetScope = 'resourceGroup'

@description('Short prefix for resource names (lowercase letters and digits).')
@minLength(3)
@maxLength(12)
param namePrefix string = 'argus'

param location string = resourceGroup().location

@description('Container image, e.g. ghcr.io/nimeshkasun/argus:1.0.0 or myregistry.azurecr.io/argus:1.0.0.')
param containerImage string

@description('Registry login for private images (leave empty for public images).')
param registryServer string = ''
param registryUsername string = ''
@secure()
param registryPassword string = ''

@description('App Service plan SKU. B2 suits small installations; P1v3 or larger for production.')
param appServiceSku string = 'B2'

@allowed(['postgres', 'mongodb'])
param databaseType string = 'postgres'

@description('Database administrator user name.')
param dbAdminUser string = 'argusadmin'

@secure()
@minLength(12)
@description('Database administrator password.')
param dbAdminPassword string

@secure()
@minLength(32)
@description('ARGUS_MASTER_KEY: at least 32 characters (openssl rand -base64 48). Back it up: without it, stored credentials cannot be recovered.')
param masterKey string

@description('Public URL, if you use a custom domain; defaults to the azurewebsites.net address.')
param publicUrl string = ''

@description('Initial password for the "admin" account; leave empty to have one generated and written to the log.')
@secure()
param adminPassword string = ''

@description('Days to keep logs in Log Analytics.')
param logRetentionDays int = 30

var suffix = uniqueString(resourceGroup().id, namePrefix)
var siteName = '${namePrefix}-${suffix}'
var keyVaultName = take('kv-${namePrefix}-${suffix}', 24)
var appUrl = empty(publicUrl) ? 'https://${siteName}.azurewebsites.net' : publicUrl
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

// ---------------------------------------------------------------- monitoring

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePrefix}-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

// ---------------------------------------------------------------- database

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (databaseType == 'postgres') {
  name: 'pg-${namePrefix}-${suffix}'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource postgresDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (databaseType == 'postgres') {
  parent: postgres
  name: 'argus'
}

// Allows connections from Azure services (including this web app). For a private network, replace with VNet
// integration and a private endpoint (see docs/deployment/azure.md).
resource postgresAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (databaseType == 'postgres') {
  parent: postgres
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource mongo 'Microsoft.DocumentDB/mongoClusters@2024-07-01' = if (databaseType == 'mongodb') {
  name: 'mongo-${namePrefix}-${suffix}'
  location: location
  properties: {
    administrator: { userName: dbAdminUser, password: dbAdminPassword }
    serverVersion: '7.0'
    compute: { tier: 'M10' }
    storage: { sizeGb: 32 }
    sharding: { shardCount: 1 }
    highAvailability: { targetMode: 'Disabled' }
    publicNetworkAccess: 'Enabled'
  }
}

resource mongoAzure 'Microsoft.DocumentDB/mongoClusters/firewallRules@2024-07-01' = if (databaseType == 'mongodb') {
  parent: mongo
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

var postgresUrl = 'postgres://${dbAdminUser}:${uriComponent(dbAdminPassword)}@pg-${namePrefix}-${suffix}.postgres.database.azure.com:5432/argus?sslmode=require'
var mongoUrl = 'mongodb+srv://${dbAdminUser}:${uriComponent(dbAdminPassword)}@mongo-${namePrefix}-${suffix}.global.mongocluster.cosmos.azure.com/argus?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000'

// ---------------------------------------------------------------- secrets

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
  }
}

resource masterKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'argus-master-key'
  properties: { value: masterKey }
}

resource dbUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'argus-db-url'
  properties: { value: databaseType == 'postgres' ? postgresUrl : mongoUrl }
}

resource adminPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(adminPassword)) {
  parent: vault
  name: 'argus-admin-password'
  properties: { value: adminPassword }
}

// ---------------------------------------------------------------- app

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-${namePrefix}-${suffix}'
  location: location
  kind: 'linux'
  sku: { name: appServiceSku }
  properties: { reserved: true }
}

// App settings that App Service resolves from Key Vault with the web app's managed identity.
var kvDbUrl = '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=argus-db-url)'
var kvMasterKey = '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=argus-master-key)'
var kvAdminPassword = '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=argus-admin-password)'

var registrySettings = empty(registryServer)
  ? []
  : [
      { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://${registryServer}' }
      { name: 'DOCKER_REGISTRY_SERVER_USERNAME', value: registryUsername }
      { name: 'DOCKER_REGISTRY_SERVER_PASSWORD', value: registryPassword }
    ]

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: siteName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: 'SystemAssigned'
    siteConfig: {
      linuxFxVersion: 'DOCKER|${containerImage}'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/healthz'
      appSettings: concat(
        [
          { name: 'WEBSITES_PORT', value: '8080' }
          { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
          { name: 'ARGUS_ROLE', value: 'all' }
          { name: 'ARGUS_DB_TYPE', value: databaseType }
          { name: 'ARGUS_DB_URL', value: kvDbUrl }
          { name: 'ARGUS_MASTER_KEY', value: kvMasterKey }
          { name: 'ARGUS_PUBLIC_URL', value: appUrl }
          // App Service terminates TLS in front of the container: trust one proxy hop for client IPs.
          { name: 'ARGUS_TRUST_PROXY', value: '1' }
        ],
        empty(adminPassword) ? [] : [{ name: 'ARGUS_ADMIN_PASSWORD', value: kvAdminPassword }],
        registrySettings
      )
    }
  }
}

// The web app's identity may read secrets (and only that).
resource kvAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, site.id, keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource siteLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: site
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output url string = appUrl
output webAppName string = site.name
output keyVaultName string = vault.name
output webAppPrincipalId string = site.identity.principalId
