/**
 * User-selectable presets for tightening the volume floor above the server
 * default (`PSX_MIN_VOLUME`, see lib/cache.js) at request time. A value at or
 * below the server default is a no-op — stocks thinner than that floor were
 * never fetched in the first place, so there's nothing left to reveal by
 * asking for less. Shared between the server (lib/cache.js) and the client
 * filter control (app/components/VolumeFilter.js) so both stay in sync
 * without pulling server-only fetch code into the client bundle.
 */
export const VOLUME_FILTER_PRESETS = [250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
