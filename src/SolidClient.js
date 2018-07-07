const { resolve, parse: parseUrl } = require('url');
const https = require('https');
const querystring = require('querystring');
const RelyingParty = require('@trust/oidc-rp');
const PoPToken = require('@trust/oidc-rp/lib/PoPToken');

// Fake redirect URL
const redirectUrl = 'http://example.org/';

class SolidClient {
  constructor({ identityManager }) {
    this._identityManager = identityManager;
  }

  /**
   * Logs the user in with the given identity provider
   *
   * @param identityProvider string The URL of the identity provider
   * @param credentials object An object with username and password keys
   *
   * @returns Promise<Session> A session for the given user
   */
  async login(identityProvider, credentials) {
    // Obtain a relying party
    const relyingParty = await this.getRelyingParty(identityProvider);

    // Load or create a session
    const username = credentials.username;
    let session = this._identityManager.getSession(relyingParty, username);
    if (!session) {
      session = await this.createSession(relyingParty, credentials);
      this._identityManager.addSession(relyingParty, username, session);
    }
    return session;
  }

  /**
   * Logs the user in with the given identity provider
   *
   * @param relyingParty RelyingParty The relying party
   * @param credentials object An object with username and password keys
   *
   * @returns Promise<Session> A session for the given user
   */
  async createSession(relyingParty, credentials) {
    // Obtain the authorization URL
    const authData = {};
    const authUrl = await relyingParty.createRequest({ redirect_uri: redirectUrl }, authData);

    // Perform the login
    const loginParams = await this.getLoginParams(authUrl);
    const accessUrl = await this.performLogin(loginParams.loginUrl, loginParams, credentials);
    const session = await relyingParty.validateResponse(accessUrl, authData);

    return session;
  }

  /**
   * Creates an access token for the given URL.
   *
   * @param url string
   * @param session Session
   *
   * @returns Promise<string> An access token
   */
  async createToken(url, session) {
    return PoPToken.issueFor(url, session);
  }

  /**
   * Obtains a relying party for the given identity provider.
   *
   * @param identityProvider string The URL of the identity provider
   *
   * @returns Promise<RelyingParty> A relying party
   */
  async getRelyingParty(identityProvider) {
    // Try to load an existing relying party
    let relyingParty;
    const providerSettings = this._identityManager.getProviderSettings(identityProvider);
    if (providerSettings) {
      relyingParty = RelyingParty.from(providerSettings);
    }
    // Create a new relying party
    else {
      relyingParty = await this.registerRelyingParty(identityProvider);
      this._identityManager.addProviderSettings(relyingParty);
    }
    return relyingParty;
  }

  /**
   * Registers a relying party for the given identity provider.
   *
   * @param identityProvider string The URL of the identity provider
   *
   * @returns Promise<RelyingParty> A relying party
   */
  async registerRelyingParty(identityProvider) {
    const responseType = 'id_token token';
    const registration = {
      issuer: identityProvider,
      grant_types: ['implicit'],
      redirect_uris: [redirectUrl],
      response_types: [responseType],
      scope: 'openid profile',
    };
    const options = {
      defaults: {
        authenticate: {
          redirect_uri: redirectUrl,
          response_type: responseType,
        },
      },
    };
    return RelyingParty.register(identityProvider, registration, options);
  }

  /**
   * Obtains the login parameters through the given authentication URL.
   *
   * @param authUrl String The authentication URL
   *
   * @returns Promise<object> A key/value object of login parameters
   */
  async getLoginParams(authUrl) {
    // Retrieve the login page in HTML
    const authorizationPage = await this.fetch(authUrl);
    const loginPageUrl = resolve(authUrl, authorizationPage.headers.location);
    const loginPage = await this.fetch(loginPageUrl);

    // Extract the password form's target URL
    const passwordForm = loginPage.body.match(/<form[^]*?<\/form>/)[0];
    const loginUrl = resolve(loginPageUrl, passwordForm.match(/action="([^"]+)"/)[1]);

    // Extract the password form's hidden fields
    const loginParams = { loginUrl };
    let match, inputRegex = /<input.*?name="([^"]+)".*?value="([^"]+)"/g;
    while (match = inputRegex.exec(passwordForm))
      loginParams[match[1]] = match[2];

    return loginParams;
  }

  /**
   * Sends the login information to the login page.
   *
   * @param loginUrl string The URL of the login page
   * @param loginParams object The login parameters
   * @param credentials object The user's credentials
   *
   * @returns Promise<string> An access URL.
   */
  async performLogin(loginUrl, loginParams, credentials) {
    // Set the credentials
    loginParams.username = credentials.username;
    loginParams.password = credentials.password;

    // Perform the login POST request
    const options = parseUrl(loginUrl);
    const postData = querystring.stringify(loginParams);
    options.method = 'POST';
    options.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': postData.length,
    };
    const loginResponse = await this.fetch(options, postData);

    // Verify the login was successful
    if (loginResponse.statusCode !== 302) {
      const message = loginResponse.body.match(/<strong>(.*?)<\/strong>/);
      const cause = message ? message[1] : 'unknown cause';
      throw new Error(`Could not log in: ${cause}`);
    }

    // Redirect to the authentication page, passing the session cookie
    const authUrl = loginResponse.headers.location;
    const cookie = loginResponse.headers['set-cookie'][0].replace(/;.*/, '');
    const authResponse = await this.fetch(Object.assign(parseUrl(authUrl), {
      headers: { cookie },
    }));

    // Obtain the access URL from the redirected response
    const accessUrl = authResponse.headers.location;
    return accessUrl;
  }

  /**
   * Fetches the given resource over HTTP.
   *
   * @param options object The request options
   * @param data? string The request body
   *
   * @returns Promise<Response> The HTTP response with a body property
   */
  fetch(options, data) {
    return new Promise((resolve, reject) => {
      const request = https.request(options);
      request.end(data);
      request.on('response', response => {
        response.body = '';
        response.on('data', data => response.body += data);
        response.on('end', () => resolve(response));
      });
      request.on('error', reject);
    });
  }
}

module.exports = SolidClient;
