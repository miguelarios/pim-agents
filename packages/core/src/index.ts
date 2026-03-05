export {
  type CardDavConfig,
  loadCardDavConfig,
} from "./config.js";

export {
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  ContactError,
  ErrorCode,
  PimError,
  ValidationError,
  isRetryableError,
  toPimError,
} from "./errors.js";

export {
  type Contact,
  buildVCard,
  parseVCard,
} from "./vcard.js";
