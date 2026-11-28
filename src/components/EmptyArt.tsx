/* ------------------------------------------------------------------
   The empty states, drawn.

   An empty page used to say so with an emoji and two lines of grey type,
   which on a new book turned every screen into the same sad face. Each now
   has a small scene of its own, in the hand drivea draws its dashboard's
   empty cards in: a wallet waiting for its first account, a folder with
   nothing in it, a tray cleared with a tick over it.

   No colour is named here. Every shape wears an `.ea-*` class from
   `app.css`, which mixes the state's own `--e-accent` (set by its tone)
   with the surface or black, so a scene follows its tone and every theme,
   light or dark. Decorative, so `aria-hidden`: the title and the line under
   it say what the state is.
   ------------------------------------------------------------------ */

import type { ReactElement } from 'react';

export type EmptyArtName =
  | 'wallet' | 'card' | 'receipt' | 'search' | 'inbox' | 'calendar'
  | 'calendar-done' | 'folder' | 'tags' | 'label' | 'templates' | 'debts'
  | 'growth' | 'gold' | 'bank' | 'taxes' | 'donut' | 'shop' | 'fail';

/** A four-pointed glint, centred on (x, y). */
function Sparkle({ x, y, r = 4 }: { x: number; y: number; r?: number }) {
  const k = r * 0.28;
  return (
    <path
      className="ea-spark"
      d={`M${x} ${y - r} Q${x + k} ${y - k} ${x + r} ${y} Q${x + k} ${y + k} ${x} ${y + r} Q${x - k} ${y + k} ${x - r} ${y} Q${x - k} ${y - k} ${x} ${y - r}Z`}
    />
  );
}

/** A round badge with a tick in it, centred on (x, y). */
function Tick({ x, y, r = 10 }: { x: number; y: number; r?: number }) {
  const k = r / 9;
  return (
    <g>
      <circle className="ea-fill" cx={x} cy={y} r={r} />
      <path
        className="ea-stroke-on"
        d={`M${x - 4 * k} ${y + 0.2 * k} L${x - 1.2 * k} ${y + 3 * k} L${x + 4.2 * k} ${y - 2.8 * k}`}
        strokeWidth={2.4 * k}
      />
    </g>
  );
}

/** A round badge with a plus in it: something to add. */
function Plus({ x, y, r = 11 }: { x: number; y: number; r?: number }) {
  const k = r / 11;
  return (
    <g>
      <circle className="ea-fill" cx={x} cy={y} r={r} />
      <path
        className="ea-stroke-on"
        d={`M${x} ${y - 5 * k} V${y + 5 * k} M${x - 5 * k} ${y} H${x + 5 * k}`}
        strokeWidth={2.8 * k}
      />
    </g>
  );
}

/** The ground a scene stands on. */
function Shadow({ cx = 60, cy = 79, rx = 36 }: { cx?: number; cy?: number; rx?: number }) {
  return <ellipse className="ea-shadow" cx={cx} cy={cy} rx={rx} ry="3.5" />;
}

/** A diary page: the grid of days, the rings at the top. */
function CalendarPage() {
  return (
    <>
      <rect className="ea-page ea-edge" x="28" y="14" width="62" height="60" rx="9" />
      <path className="ea-fill" d="M28 23 Q28 14 37 14 H81 Q90 14 90 23 V29 H28 Z" />
      <rect className="ea-deep" x="41" y="8" width="5" height="12" rx="2.5" />
      <rect className="ea-deep" x="72" y="8" width="5" height="12" rx="2.5" />
      {[0, 1, 2, 3].map((col) =>
        [0, 1, 2].map((row) => (
          <rect
            key={`${col}-${row}`}
            className={col === 2 && row === 1 ? 'ea-mid' : 'ea-glass'}
            x={36 + col * 12.5}
            y={35 + row * 12}
            width="9"
            height="8"
            rx="2.5"
          />
        )),
      )}
    </>
  );
}

const SCENES: Record<EmptyArtName, () => ReactElement> = {
  /* A wallet with a card tucked in it: wherever the money sits. */
  wallet: () => (
    <>
      <Shadow rx={38} />
      <rect className="ea-mid" x="32" y="14" width="46" height="30" rx="5" transform="rotate(-9 55 29)" />
      <rect className="ea-soft ea-edge" x="42" y="10" width="46" height="30" rx="5" transform="rotate(7 65 25)" />
      <rect className="ea-fill" x="22" y="30" width="72" height="46" rx="11" />
      <path className="ea-deep" d="M22 41 Q22 30 33 30 H83 Q94 30 94 41 V43 H22 Z" opacity="0.4" />
      <rect className="ea-page" x="72" y="46" width="28" height="17" rx="8.5" />
      <circle className="ea-fill" cx="81" cy="54.5" r="3.6" />
      <Sparkle x={16} y={24} r={4.5} />
      <Sparkle x={104} y={20} r={3.5} />
      <Sparkle x={108} y={74} r={3} />
    </>
  ),

  /* A card, with a plus for the first one. */
  card: () => (
    <>
      <Shadow rx={38} cy={80} />
      <g transform="rotate(-7 56 46)">
        <rect className="ea-soft ea-edge" x="28" y="18" width="66" height="42" rx="8" />
        <rect className="ea-fill" x="20" y="28" width="70" height="44" rx="8" />
        <rect className="ea-deep" x="20" y="37" width="70" height="8" opacity="0.5" />
        <rect className="ea-on" x="28" y="51" width="12" height="9" rx="2" opacity="0.85" />
        <rect className="ea-on" x="28" y="63" width="30" height="3" rx="1.5" opacity="0.6" />
      </g>
      <Plus x={94} y={64} r={13} />
      <Sparkle x={102} y={22} r={4} />
      <Sparkle x={14} y={20} r={3} />
    </>
  ),

  /* A till receipt with nothing much on it yet. */
  receipt: () => (
    <>
      <Shadow rx={30} />
      <path
        className="ea-page ea-edge"
        d="M36 12 Q36 8 40 8 H80 Q84 8 84 12 V74 L78 70 L72 74 L66 70 L60 74 L54 70 L48 74 L42 70 L36 74 Z"
      />
      <rect className="ea-mid" x="44" y="18" width="20" height="5" rx="2.5" />
      <rect className="ea-glass" x="44" y="30" width="32" height="4" rx="2" />
      <rect className="ea-glass" x="44" y="38" width="24" height="4" rx="2" />
      <rect className="ea-glass" x="44" y="46" width="28" height="4" rx="2" />
      <path className="ea-dash" d="M44 56 H76" />
      <rect className="ea-soft" x="60" y="60" width="16" height="5" rx="2.5" />
      <Plus x={90} y={22} />
      <Sparkle x={22} y={30} r={4} />
      <Sparkle x={100} y={58} r={3} />
    </>
  ),

  /* A lens over a list that has nothing in it. */
  search: () => (
    <>
      <Shadow rx={40} />
      <rect className="ea-page ea-edge" x="18" y="14" width="68" height="60" rx="10" />
      {[0, 1, 2].map((row) => (
        <g key={row} opacity={1 - row * 0.28}>
          <circle className="ea-glass" cx="30" cy={29 + row * 16} r="5" />
          <rect className="ea-glass" x="40" y={26 + row * 16} width={row === 1 ? 24 : 34} height="5" rx="2.5" />
        </g>
      ))}
      <path className="ea-handle" d="M88 58 L101 71" />
      <circle className="ea-lens" cx="78" cy="48" r="15" />
      <path className="ea-trail" d="M71 44 Q74 39 79 39" />
      <Sparkle x={104} y={22} r={4} />
      <Sparkle x={12} y={64} r={3} />
    </>
  ),

  /* An empty tray, cleared, with a tick floating over it. */
  inbox: () => (
    <>
      <Shadow rx={38} />
      <path className="ea-soft" d="M28 50 L38 30 Q40 26 45 26 H75 Q80 26 82 30 L92 50 V68 Q92 76 84 76 H36 Q28 76 28 68 Z" />
      <path className="ea-mid" d="M28 50 H46 Q48 50 49 52 L51 57 Q52 59 54 59 H66 Q68 59 69 57 L71 52 Q72 50 74 50 H92 V68 Q92 76 84 76 H36 Q28 76 28 68 Z" />
      <rect className="ea-page" x="44" y="34" width="32" height="4" rx="2" opacity="0.8" />
      <rect className="ea-page" x="48" y="42" width="24" height="4" rx="2" opacity="0.6" />
      <Tick x={88} y={20} r={11} />
      <Sparkle x={24} y={22} r={4} />
      <Sparkle x={104} y={46} r={3} />
    </>
  ),

  /* A diary page and a turning arrow: what comes round again. */
  calendar: () => (
    <>
      <Shadow rx={34} />
      <CalendarPage />
      <circle className="ea-page ea-edge" cx="90" cy="66" r="12" />
      <path className="ea-stroke" d="M84.5 66 A5.5 5.5 0 1 1 90 71.5" />
      <path className="ea-stroke" d="M84.5 61 V66 H89.5" />
      <Sparkle x={18} y={30} r={4} />
      <Sparkle x={104} y={22} r={3} />
    </>
  ),

  /* The same page with a tick: nothing left to come. */
  'calendar-done': () => (
    <>
      <Shadow rx={34} />
      <CalendarPage />
      <Tick x={90} y={66} r={12} />
      <Sparkle x={18} y={30} r={4} />
      <Sparkle x={104} y={22} r={3} />
    </>
  ),

  /* A folder, open a crack, with a sheet waiting to go in. */
  folder: () => (
    <>
      <Shadow rx={40} />
      <path className="ea-mid" d="M20 26 Q20 19 27 19 H46 Q49 19 51 21 L56 26 H93 Q100 26 100 33 V70 Q100 76 94 76 H26 Q20 76 20 70 Z" />
      <rect className="ea-page ea-edge" x="34" y="16" width="48" height="34" rx="4" transform="rotate(-5 58 33)" />
      <rect className="ea-glass" x="40" y="24" width="26" height="4" rx="2" transform="rotate(-5 58 33)" />
      <rect className="ea-glass" x="40" y="32" width="18" height="4" rx="2" transform="rotate(-5 58 33)" />
      <path className="ea-fill" d="M20 42 Q20 37 25 37 H95 Q100 37 100 42 V70 Q100 76 94 76 H26 Q20 76 20 70 Z" />
      <rect className="ea-on" x="50" y="52" width="20" height="4" rx="2" opacity="0.55" />
      <Sparkle x={12} y={26} r={4} />
      <Sparkle x={108} y={18} r={3.5} />
    </>
  ),

  /* Two tags, one over the other: how spending is sorted. */
  tags: () => (
    <>
      <Shadow rx={40} />
      <g transform="rotate(-14 48 40)">
        <path className="ea-soft ea-edge" d="M22 28 H60 L74 40 L60 52 H22 Q18 52 18 48 V32 Q18 28 22 28 Z" />
        <circle className="ea-page" cx="63" cy="40" r="3" />
        <rect className="ea-glass" x="26" y="37" width="24" height="5" rx="2.5" />
      </g>
      <g transform="rotate(9 70 52)">
        <path className="ea-fill" d="M40 40 H82 L97 53 L82 66 H40 Q36 66 36 62 V44 Q36 40 40 40 Z" />
        <circle className="ea-page" cx="86" cy="53" r="3.4" />
        <rect className="ea-on" x="45" y="50" width="28" height="6" rx="3" opacity="0.85" />
      </g>
      <Sparkle x={104} y={22} r={4} />
      <Sparkle x={14} y={66} r={3} />
    </>
  ),

  /* A page with a ribbon marking it. */
  label: () => (
    <>
      <Shadow rx={32} />
      <rect className="ea-page ea-edge" x="30" y="16" width="56" height="60" rx="8" />
      <rect className="ea-glass" x="38" y="30" width="26" height="4" rx="2" />
      <rect className="ea-glass" x="38" y="38" width="38" height="4" rx="2" />
      <rect className="ea-glass" x="38" y="46" width="32" height="4" rx="2" />
      <rect className="ea-glass" x="38" y="54" width="20" height="4" rx="2" />
      <path className="ea-fill" d="M68 10 H84 V46 L76 39 L68 46 Z" />
      <path className="ea-deep" d="M68 10 H84 V14 H68 Z" opacity="0.4" />
      <Sparkle x={100} y={28} r={4} />
      <Sparkle x={18} y={22} r={3} />
    </>
  ),

  /* A transaction card on a stack of them, and a plus for the next. */
  templates: () => (
    <>
      <Shadow rx={38} />
      <rect className="ea-soft" x="30" y="14" width="56" height="20" rx="6" transform="rotate(-6 58 24)" />
      <rect className="ea-mid" x="25" y="29" width="64" height="22" rx="7" />
      <circle className="ea-page" cx="36" cy="40" r="5" opacity="0.8" />
      <rect className="ea-page" x="46" y="37" width="26" height="4" rx="2" opacity="0.8" />
      <rect className="ea-page ea-edge" x="20" y="47" width="72" height="26" rx="8" />
      <circle className="ea-fill" cx="33" cy="60" r="6.5" />
      <rect className="ea-glass" x="45" y="55" width="28" height="4" rx="2" />
      <rect className="ea-glass" x="45" y="62" width="18" height="4" rx="2" />
      <Plus x={94} y={30} />
      <Sparkle x={14} y={24} r={4} />
      <Sparkle x={106} y={62} r={3} />
    </>
  ),

  /* Two coins passed between two hands, and the tick of it settled. */
  debts: () => (
    <>
      <Shadow rx={38} />
      <circle className="ea-mid" cx="40" cy="48" r="18" />
      <circle className="ea-soft" cx="40" cy="48" r="13" />
      <text className="ea-glyph ea-glyph-deep" x="40" y="54.5">₹</text>
      <circle className="ea-fill" cx="78" cy="38" r="18" />
      <circle className="ea-ring-on" cx="78" cy="38" r="13" />
      <text className="ea-glyph" x="78" y="44.5">₹</text>
      <path className="ea-trail" d="M38 24 Q50 12 64 15" />
      <path className="ea-trail" d="M58 11 L64 15 L59 20" />
      <path className="ea-trail" d="M80 62 Q70 74 56 70" />
      <path className="ea-trail" d="M61 75 L56 70 L61 66" />
      <Tick x={98} y={66} r={10} />
      <Sparkle x={16} y={22} r={4} />
      <Sparkle x={104} y={16} r={3} />
    </>
  ),

  /* Bars climbing, and the line over them. */
  growth: () => (
    <>
      <Shadow rx={40} />
      <rect className="ea-glass" x="20" y="12" width="80" height="64" rx="12" />
      <rect className="ea-soft" x="31" y="52" width="11" height="16" rx="3" />
      <rect className="ea-mid" x="47" y="44" width="11" height="24" rx="3" />
      <rect className="ea-mid" x="63" y="36" width="11" height="32" rx="3" />
      <rect className="ea-fill" x="79" y="26" width="11" height="42" rx="3" />
      <path className="ea-line" d="M30 44 L46 34 L60 38 L84 16" />
      <path className="ea-line" d="M76 15 H85 V24" />
      <Sparkle x={12} y={22} r={4} />
      <Sparkle x={108} y={52} r={3.5} />
    </>
  ),

  /* Three bars of gold, stacked. */
  gold: () => (
    <>
      <Shadow rx={42} cy={78} />
      <path className="ea-fill" d="M20 74 L27 56 H55 L62 74 Z" />
      <path className="ea-mid" d="M27 56 H55 L53 61 H29 Z" />
      <path className="ea-fill" d="M58 74 L65 56 H93 L100 74 Z" />
      <path className="ea-mid" d="M65 56 H93 L91 61 H67 Z" />
      <path className="ea-fill" d="M39 54 L46 36 H74 L81 54 Z" />
      <path className="ea-mid" d="M46 36 H74 L72 41 H48 Z" />
      <path className="ea-on" d="M50 46 L52 42 H58 L55 50 Z" opacity="0.35" />
      <path className="ea-deep" d="M20 74 H62 V75 H20 Z M58 74 H100 V75 H58 Z" opacity="0.5" />
      <Sparkle x={86} y={24} r={6} />
      <Sparkle x={30} y={30} r={4} />
      <Sparkle x={104} y={44} r={3} />
    </>
  ),

  /* A bank, and the percentage it pays. */
  bank: () => (
    <>
      <Shadow rx={40} />
      <path className="ea-fill" d="M22 34 L60 13 L98 34 Z" />
      <circle className="ea-page" cx="60" cy="26" r="4" />
      <rect className="ea-deep" x="24" y="34" width="72" height="5" rx="1.5" />
      {[35, 49, 63, 77].map((x) => (
        <rect key={x} className="ea-mid" x={x} y="42" width="8" height="24" rx="2" />
      ))}
      <rect className="ea-fill" x="22" y="67" width="76" height="8" rx="2.5" />
      <circle className="ea-page ea-edge" cx="100" cy="20" r="11" />
      <text className="ea-glyph ea-glyph-accent ea-glyph-small" x="100" y="24.5">%</text>
      <Sparkle x={14} y={22} r={4} />
      <Sparkle x={108} y={56} r={3} />
    </>
  ),

  /* A return, with the rupee stamped on it. */
  taxes: () => (
    <>
      <Shadow rx={32} />
      <path className="ea-page ea-edge" d="M34 10 H66 L80 24 V72 Q80 76 76 76 H34 Q30 76 30 72 V14 Q30 10 34 10 Z" />
      <path className="ea-soft" d="M66 10 V20 Q66 24 70 24 H80 Z" />
      <rect className="ea-glass" x="38" y="30" width="30" height="4" rx="2" />
      <rect className="ea-glass" x="38" y="38" width="24" height="4" rx="2" />
      <rect className="ea-glass" x="38" y="46" width="28" height="4" rx="2" />
      <circle className="ea-fill" cx="82" cy="60" r="15" />
      <circle className="ea-ring-on" cx="82" cy="60" r="11" />
      <text className="ea-glyph" x="82" y="66">₹</text>
      <Sparkle x={104} y={28} r={4} />
      <Sparkle x={18} y={26} r={3} />
    </>
  ),

  /* A ring with only its first slice in it. */
  donut: () => (
    <>
      <Shadow rx={40} cy={80} />
      <circle className="ea-ring" cx="46" cy="42" r="24" />
      <circle
        className="ea-ring ea-ring-fill"
        cx="46"
        cy="42"
        r="24"
        strokeDasharray="34 200"
        transform="rotate(-90 46 42)"
      />
      <circle className="ea-page" cx="46" cy="42" r="14" />
      {[0, 1, 2].map((row) => (
        <g key={row}>
          <circle className={row === 0 ? 'ea-fill' : 'ea-soft'} cx="84" cy={30 + row * 12} r="3.5" />
          <rect className="ea-glass" x="91" y={28 + row * 12} width={row === 0 ? 18 : 13} height="4" rx="2" />
        </g>
      ))}
      <Sparkle x={16} y={16} r={4} />
      <Sparkle x={100} y={72} r={3} />
    </>
  ),

  /* A shopfront with its awning out. */
  shop: () => (
    <>
      <Shadow rx={40} />
      <rect className="ea-page ea-edge" x="28" y="30" width="64" height="46" rx="4" />
      <rect className="ea-fill" x="22" y="18" width="76" height="14" rx="4" />
      {[0, 2, 4].map((i) => (
        <rect key={i} className="ea-on" x={30 + i * 12} y="18" width="12" height="14" opacity="0.3" />
      ))}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <circle key={i} className="ea-fill" cx={28.3 + i * 12.7} cy="32" r="6.3" />
      ))}
      <rect className="ea-glass" x="35" y="46" width="15" height="13" rx="2.5" />
      <rect className="ea-glass" x="70" y="46" width="15" height="13" rx="2.5" />
      <rect className="ea-mid" x="53" y="50" width="14" height="26" rx="2.5" />
      <Sparkle x={12} y={24} r={4} />
      <Sparkle x={108} y={50} r={3} />
    </>
  ),

  /* A book that would not open. Drawn in red by its tone. */
  fail: () => (
    <>
      <Shadow rx={32} />
      <path className="ea-soft ea-edge" d="M30 18 Q30 12 36 12 H82 Q88 12 88 18 V70 Q88 76 82 76 H36 Q30 76 30 70 Z" />
      <path className="ea-mid" d="M30 18 Q30 12 36 12 H40 V76 H36 Q30 76 30 70 Z" />
      <rect className="ea-page" x="48" y="24" width="30" height="5" rx="2.5" />
      <rect className="ea-glass" x="48" y="33" width="22" height="4" rx="2" />
      <circle className="ea-fill" cx="88" cy="62" r="14" />
      <rect className="ea-on" x="86" y="53" width="4" height="11" rx="2" />
      <circle className="ea-on" cx="88" cy="68.5" r="2.2" />
    </>
  ),
};

export function EmptyArt({ name, className = 'empty-art' }: { name: EmptyArtName; className?: string }) {
  const Scene = SCENES[name];
  return (
    <svg className={className} viewBox="0 0 120 86" aria-hidden="true" focusable="false">
      <Scene />
    </svg>
  );
}
