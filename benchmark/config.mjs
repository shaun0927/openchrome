// Benchmark Configuration
// 20 Famous Twitter/X Celebrities
export const TARGETS = [
  { handle: 'elonmusk', name: 'Elon Musk' },
  { handle: 'BillGates', name: 'Bill Gates' },
  { handle: 'BarackObama', name: 'Barack Obama' },
  { handle: 'cristiano', name: 'Cristiano Ronaldo' },
  { handle: 'justinbieber', name: 'Justin Bieber' },
  { handle: 'taylorswift13', name: 'Taylor Swift' },
  { handle: 'katyperry', name: 'Katy Perry' },
  { handle: 'rihanna', name: 'Rihanna' },
  { handle: 'KimKardashian', name: 'Kim Kardashian' },
  { handle: 'selenagomez', name: 'Selena Gomez' },
  { handle: 'JeffBezos', name: 'Jeff Bezos' },
  { handle: 'TimCook', name: 'Tim Cook' },
  { handle: 'sama', name: 'Sam Altman' },
  { handle: 'ylecun', name: 'Yann LeCun' },
  { handle: 'neymarjr', name: 'Neymar Jr' },
  { handle: 'Oprah', name: 'Oprah Winfrey' },
  { handle: 'KevinHart4real', name: 'Kevin Hart' },
  { handle: 'TheRock', name: 'Dwayne Johnson' },
  { handle: 'shakira', name: 'Shakira' },
  { handle: 'BrunoMars', name: 'Bruno Mars' },
];

export const CDP_ENDPOINT = 'http://localhost:9222';
export const RESULTS_DIR = new URL('./results/', import.meta.url).pathname;
