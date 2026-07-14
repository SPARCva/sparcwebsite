// Shared catalog for the Access Trails note forms and feeds.
// Location + park lists mirror accesstrails/data/{centers,parks}.json (the
// static-site generator's source of truth); update both together.
// The feature taxonomy mirrors the /ART report form's grouped barrier types,
// re-worded for parks and aligned with the guide's rating categories.

export const LOCATIONS = {
  alexandria: { name: 'Alexandria', center: 'SPARC Alexandria' },
  arlington:  { name: 'Arlington',  center: 'SPARC Arlington' },
  leesburg:   { name: 'Leesburg',   center: 'SPARC Leesburg' },
  mclean:     { name: 'McLean',     center: 'SPARC McLean' },
};

export const PARKS = {
  'belle-haven':          { name: 'Belle Haven Park',              location: 'alexandria' },
  'huntley-meadows':      { name: 'Huntley Meadows Park',          location: 'alexandria' },
  'martin-luther-king-jr':{ name: 'Martin Luther King, Jr. Park',  location: 'alexandria' },
  'bluemont':             { name: 'Bluemont Park',                 location: 'arlington' },
  'glencarlyn':           { name: 'Glencarlyn Park',               location: 'arlington' },
  'potomac-crossing':     { name: 'Potomac Crossing Park',         location: 'leesburg' },
  'tuscarora':            { name: 'Tuscarora Park',                location: 'leesburg' },
  'great-falls':          { name: 'Great Falls National Park',     location: 'mclean' },
  'wolf-trap':            { name: 'Wolf Trap National Park',       location: 'mclean' },
};

export function parksFor(locationSlug) {
  return Object.entries(PARKS)
    .filter(([, p]) => p.location === locationSlug)
    .map(([slug, p]) => ({ slug, name: p.name }));
}

// Grouped like the /ART barrier-type picker: label + a plain-language hint.
export const FEATURE_GROUPS = [
  {
    group: 'Getting there',
    items: [
      { id: 'parking',  label: 'Parking',                 hint: 'accessible or van spaces, access aisles, curb ramps from the lot' },
      { id: 'dropoff',  label: 'Drop-off or loading',     hint: 'somewhere level and safe to get out of a vehicle' },
      { id: 'paths',    label: 'Paths and entrances',     hint: 'the route from parking into the park — surfaces, curb cuts, gates' },
    ],
  },
  {
    group: 'On the trails',
    items: [
      { id: 'trails',   label: 'Trails',                  hint: 'width, surface, slope, narrow squeezes, places to rest' },
    ],
  },
  {
    group: 'Facilities',
    items: [
      { id: 'bathrooms',       label: 'Bathrooms',                     hint: 'stall size, grab bars, step-free entry, sink height' },
      { id: 'picnic_seating',  label: 'Picnic shelters and seating',   hint: 'accessible tables, wheelchair space, paths to shelters' },
      { id: 'visitors_center', label: 'Visitors center or clubhouse',  hint: 'step-free entry, doors, accessible services inside' },
      { id: 'playground',      label: 'Playground',                    hint: 'adaptive equipment, surfacing a wheelchair can cross' },
      { id: 'water_features',  label: 'Water access',                  hint: 'fountains, splash pads, fishing piers, boat launches' },
    ],
  },
  {
    group: 'Information and environment',
    items: [
      { id: 'signage',  label: 'Signs and wayfinding',    hint: 'braille or raised letters, contrast, wheelchair-height placement' },
      { id: 'sensory',  label: 'Sensory environment',     hint: 'noise, lighting, crowds, quieter spots to take a break' },
    ],
  },
  {
    group: '',
    items: [{ id: 'other', label: 'Something else', hint: '' }],
  },
];

export const FEATURE_LABEL = Object.fromEntries(
  FEATURE_GROUPS.flatMap(g => g.items).map(i => [i.id, i.label])
);

// The intake taxonomy already used by the Contribute form / DB CHECK.
export const FIND_TYPES = [
  { value: 'ADA Accessible Park',            label: 'The whole park works well for accessibility' },
  { value: 'ADA Accessible Park Feature',    label: 'An accessible feature that works well' },
  { value: 'Park that needs an ADA Feature', label: 'Something that needs an accessible fix' },
];

export const FIND_BADGE = {
  'ADA Accessible Park':            'mostly-accessible',
  'ADA Accessible Park Feature':    'mostly-accessible',
  'Park that needs an ADA Feature': 'mostly-inaccessible',
};
