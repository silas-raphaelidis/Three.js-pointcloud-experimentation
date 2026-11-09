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

/**
 * An unused name for a trail of the given rating (0 green .. 3 double black).
 * Falls back to "<name> II", "<name> III"... if every name is taken.
 * Used by the editor when a trail is finished.
 */
export function pickRunName(ratingIndex, usedNames) {
  const list = RUN_NAMES[Math.max(0, Math.min(3, ratingIndex))];
  const used = new Set(usedNames);
  const free = list.filter((n) => !used.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  for (let k = 2; ; k++) {
    const roman = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][k - 2] ?? String(k);
    const candidates = list.map((n) => `${n} ${roman}`).filter((n) => !used.has(n));
    if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
