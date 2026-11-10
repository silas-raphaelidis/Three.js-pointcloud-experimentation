/**
 * Default trail names by difficulty: common and well-known run names from
 * ski areas around the US (compiled, not scraped). New trails get an unused
 * name from the list matching their rating when they're finished.
 */
export const RUN_NAMES = [
  // green
  [
    'Bunny Hop', 'Easy Street', 'Lazy Daisy', 'Meadow Run', 'Sunshine', 'Home Run',
    'Homeward Bound', 'Boulevard', 'Broadway', 'Main Street', 'Lollipop', 'Snowflake',
    'Pussyfoot', 'Cub Run', 'Powder Puff', 'Tenderfoot', 'Pioneer', 'Sleepy Hollow',
    'Ho Hum', 'Schoolhouse', 'Greenhorn', 'Wanderer', 'Rabbit Run', 'Deer Run',
    'Chipmunk', 'Bear Paw', 'Aspen Alley', 'Lower Meadows', 'Turkey Trot', 'Duck Soup',
    'Village Trail', 'Crossover', 'Sundance', 'Morning Star', 'Evergreen', 'Wagon Trail',
    'Big Easy', 'Long Trail', 'Last Run', 'Sunnyside', 'Lazy Bones', 'Easy Rider',
    'Kitten', 'Cottontail', 'Primrose', 'Ramble On', 'Pathfinder', 'Lower Lane',
    'Lift Line Lane', 'Sunday Drive',
  ],
  // blue
  [
    'Ridge Run', 'Sidewinder', 'Roundabout', 'Skyline', 'Panorama', 'Whistler',
    'Cascade', 'Bluebird', 'Blue Moon', 'Bonanza', 'Gold Rush', 'Silver Queen',
    'Showboat', 'Ramrod', 'Thunderbird', 'Bobcat', 'Lynx', 'Ptarmigan',
    'Eagle\'s Nest', 'Hawk Ridge', 'Big Dipper', 'Milky Way', 'Stargazer', 'Fanny Hill',
    'Sawmill', 'Lumberjack', 'Timberline', 'Rendezvous', 'Hidden Valley', 'Sunset Ridge',
    'Saddle', 'Spillway', 'Lost Horizon', 'Big Burn', 'Silver Bell', 'Copper Queen',
    'Upper Meadows', 'Snowshoe', 'Northwest Passage', 'Cruiser', 'Mountain Laurel', 'High Noon',
    'Rustler', 'Prospector', 'Mineshaft', 'Moonshine', 'Lookout', 'Switchback',
    'Paintbrush', 'Columbine',
  ],
  // black
  [
    'Ripsaw', 'Gunbarrel', 'Outer Limits', 'Hellgate', 'Widowmaker', 'Goat Path',
    'The Wall', 'Headwall', 'Steeplechase', 'Nosedive', 'Ambush', 'Grizzly',
    'Rattlesnake', 'Diamondback', 'Cornice', 'Cliffhanger', 'Plunge', 'Kamikaze',
    'Lightning', 'Thunderbolt', 'Hurricane', 'Tornado', 'Rock Garden', 'Mogul Alley',
    'Panther', 'Wolverine', 'Bronco', 'Outlaw', 'Renegade', 'Desperado',
    'Rampage', 'Rumble', 'Wildcat', 'Hangman\'s Hollow', 'Deadman\'s Gulch', 'Liftline',
    'Starr', 'National', 'Paradise', 'Upper Ripsaw', 'Devil\'s Fiddle', 'Shooting Star',
    'Slalom Hill', 'Free Fall', 'Avalanche', 'Bear Trap', 'Twister', 'Hot Shot',
    'Big Bang', 'Dynamite',
  ],
  // double black
  [
    'Corbet\'s Couloir', 'Body Bag', 'Big Couloir', 'Rambo', 'Highland Bowl', 'The Fingers',
    'Baldy Chutes', 'Great Scott', 'Steep and Deep', 'Goat', 'Black Hole', 'The Abyss',
    'Death Wish', 'Hourglass', 'Gauntlet', 'Purgatory', 'Inferno', 'Hades',
    'No Name Chute', 'Toilet Bowl', 'Pallavicini', 'Tower Three Chute', 'Mine Shaft Chute', 'Granite Chief',
    'Headwall Chute', 'The Slot', 'Whiteout', 'Point of No Return', 'Last Rites', 'Vertigo',
    'Freefall Chute', 'Dragon\'s Tail', 'Devil\'s Crotch', 'Widow\'s Peak', 'Cardiac Ridge', 'Adrenaline',
    'Suicide Chute', 'Hairball', 'Exhibition', 'Kitchen Wall', 'Rock Chute', 'Eagle\'s Plunge',
    'Sidewall', 'The Notch', 'Couloir Extreme', 'Hanging Valley', 'Big Rock Chute', 'Christmas Tree Chute',
    'Thread the Needle', 'Shaft',
  ],
];

/** Default lift names, in the style of chairlifts around the US (compiled, not scraped). */
export const LIFT_NAMES = [
  'Summit Express', 'Mountain Express', 'Village Express', 'Peak Express', 'Ridge Express',
  'Valley Express', 'Northside Express', 'Base Area Express', 'Sunrise Quad', 'Sunset Quad',
  'Timberline Quad', 'North Peak Quad', 'South Peak Quad', 'Eagle Quad', 'Glades Quad',
  'Skyline Chair', 'Sunnyside Chair', 'Treeline Chair', 'Hilltop Chair', 'Ridgeline Chair',
  'Headwall Chair', 'Backside Chair', 'Lookout Chair', 'Meadow Chair', 'Summit Chair',
  'Alpine Double', 'Mountain Double', 'Birch Double', 'Pine Knob Double', 'Old Summit Double',
  'Stony Brook Triple', 'Cascade Triple', 'Spruce Triple', 'Maple Triple', 'Bear Hollow Triple',
  'Sky Ride', 'Cloud Nine', 'Stairway', 'High Line', 'The Ladder',
  'Upper Mountain Lift', 'Lower Mountain Lift', 'Base Lodge Lift', 'Beginner Chair', 'Learning Hill Lift',
  'Sawmill Lift', 'Quarry Lift', 'Pinnacle Lift', 'Windham Line', 'Connector Lift',
];

/**
 * A random unused name from `list`, falling back to "<name> II", "<name> III"...
 * if every name is taken. `random` returns a number in [0, 1); a seeded one
 * makes a generated mountain's names repeat with its seed.
 * Used by pickRunName and pickLiftName.
 */
function pickFrom(list, usedNames, random = Math.random) {
  const used = new Set(usedNames);
  const free = list.filter((n) => !used.has(n));
  if (free.length) return free[Math.floor(random() * free.length)];
  for (let k = 2; ; k++) {
    const roman = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][k - 2] ?? String(k);
    const candidates = list.map((n) => `${n} ${roman}`).filter((n) => !used.has(n));
    if (candidates.length) return candidates[Math.floor(random() * candidates.length)];
  }
}

/**
 * An unused name for a trail of the given rating (0 green .. 3 double black).
 * Used by the editor when a trail is finished.
 */
export function pickRunName(ratingIndex, usedNames, random) {
  return pickFrom(RUN_NAMES[Math.max(0, Math.min(3, ratingIndex))], usedNames, random);
}

/** An unused name for a lift. Used by the editor when a lift is finished. */
export function pickLiftName(usedNames, random) {
  return pickFrom(LIFT_NAMES, usedNames, random);
}
