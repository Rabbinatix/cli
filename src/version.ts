// This CLI's version (package.json), sent as the user agent and compared with the API's x-rabbinatix-min-cli.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
