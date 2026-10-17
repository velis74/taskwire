/**
 * `taskwire/fastapi-viewsets` - connectors for `@dynamicforms/fastapi-viewsets` (TW-TS-025).
 *
 * The modules behind it import fastapi-viewsets, an optional peer (TW-CORE-006), and none imports
 * `taskwire/muxws`. The core declares `CallEvent` structurally and never reaches them.
 */

export { viewsetCallSource } from './busy/viewset-call-source';
export {
  attachViewsetEvents,
  type AttachViewsetEventsOptions,
  detachViewsetEvents,
  ENVELOPE_EVENT,
  type ViewsetEventsOptions,
  ViewsetEventsTransport,
} from './viewset-events/viewset-events';
