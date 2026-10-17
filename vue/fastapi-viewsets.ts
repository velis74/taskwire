/**
 * `taskwire/fastapi-viewsets` - connectors for `@dynamicforms/fastapi-viewsets` (TW-TS-025).
 *
 * The one module besides `taskwire/muxws` that imports fastapi-viewsets, an optional peer
 * (TW-CORE-006). The core declares `CallEvent` structurally and never reaches this file.
 */

export { viewsetCallSource } from './busy/viewset-call-source';
