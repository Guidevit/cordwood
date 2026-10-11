export {
  EmailError,
  EmailNotConfigured,
  EmailNotSent,
  InvalidHeader,
  failureStatus,
  isSenderRefusal,
} from "./errors.js";
export {
  createEmailSender,
  type EmailConfig,
  type EmailMessage,
  type EmailSender,
  type Sender,
} from "./send.js";
export {
  createEventReader,
  type EmailEvent,
  type EventReader,
  type EventReaderConfig,
  type EventReading,
} from "./events.js";
