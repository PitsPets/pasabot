/** Every discovered web module's slots, indexed once (modules are found by glob, no registry). */
import { loadWebModules } from '../shell/modules.js';
import { indexSlots } from '../shell/slots.js';

export const slots = indexSlots(loadWebModules());
