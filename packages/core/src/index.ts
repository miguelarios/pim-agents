export {
  type CardDavConfig,
  loadCardDavConfig,
  type EmailConfig,
  loadEmailConfig,
} from "./config.js";

export {
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  ContactError,
  EmailError,
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
