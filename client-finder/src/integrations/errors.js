export class IntegrationMissingError extends Error {
  constructor(integration, howToFix) {
    super(`${integration} is not connected. ${howToFix}`);
    this.integration = integration;
    this.code = 'INTEGRATION_MISSING';
  }
}
