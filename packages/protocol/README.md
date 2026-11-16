# @pasabot/protocol

REST DTOs, WebSocket frames (`C2S`/`S2C`) and the `EventMap`, as zod schemas plus types (ARCHITECTURE.md 4).
Imports nothing else from PasaBot. Modules add events by augmentation:
`declare module '@pasabot/protocol' { interface EventMap { 'routine.fired': RoutineFireDTO } }`.
