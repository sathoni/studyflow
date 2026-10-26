/**
 * Demo mode (#demo): a small, fake StudyFlow that runs with no key and no
 * network. Used to look at the screens on a phone or in a browser, and in the
 * tests.
 *
 * All six courses (BE is the one without quizzes), 32 fake cards of
 * which three show a visual (the bundled placeholder image), quiz items, one
 * open session quiz, one finished chapter waiting for its chapter quiz, a day
 * plan, an exam, an instrument and some reviews from the past days, so the
 * queue, the boxes and the scores all have something to show.
 *
 * Everything is placed relative to "today", so the demo never goes stale. The
 * ids are fixed per position, so two loads give the same data.
 */

import type {
  Card,
  CardType,
  Chapter,
  Course,
  DayPlan,
  Exam,
  Instrument,
  InstrumentReview,
  PipelineStatus,
  Quiz,
  QuizAttempt,
  QuizItem,
  Review,
  Setting,
  Slide,
  StudySession,
  TableName,
  Tables,
} from '../lib/model.ts';
import type { Store } from '../lib/store.ts';
import { addDays, studyDay } from '../lib/dates.ts';

export const DEMO_PLACEHOLDER = './demo/placeholder.webp';

type DemoTables = { [K in TableName]: Tables[K][] };

/** A fixed uuid per kind and number: 'c' cards, 'q' items, … */
function uid(kind: number, n: number): string {
  return `00000000-0000-4000-8${kind.toString(16).padStart(3, '0')}-${n.toString(16).padStart(12, '0')}`;
}

/** Noon Brussels time on a study day, as an ISO timestamp. */
function at(day: string, hour = 12): string {
  return new Date(`${day}T${String(hour - 1).padStart(2, '0')}:00:00Z`).toISOString();
}

/* ------------------------------------------------------------------ *
 * The content, as short specs
 * ------------------------------------------------------------------ */

interface CardSpec {
  ch: string;
  type: CardType;
  q: string;
  a: string;
  more?: string;
  /** Visual on the back: slide key and crop. */
  vis?: [string, [number, number, number, number]];
  /** Quiz items: [format, stem, answer…] (see makeItems). */
  quiz?: QuizSpec[];
}

type QuizSpec =
  | ['mcq', string, string, string, string, string] // stem, right, wrong×3
  | ['tf', string, boolean, string?] // statement, true?, correction
  | ['cloze', string, string[]] // stem with ____, accepted answers
  | ['numeric', string, number, string, number]; // stem, value, unit, tolerance

const CARDS: CardSpec[] = [
  // SCM H2 (finished chapter)
  { ch: 'SCM-H2', type: 'begrip', q: 'Wat is **supply chain management** in één zin?', a: 'Het **afstemmen van goederen-, informatie- en geldstromen** van leverancier tot klant.', quiz: [['mcq', 'Welke stromen stemt supply chain management af?', 'Goederen, informatie en geld', 'Alleen goederen', 'Alleen informatie', 'Personeel en machines'], ['tf', 'Supply chain management gaat alleen over transport.', false, 'Het gaat over goederen-, informatie- én geldstromen.']] },
  { ch: 'SCM-H2', type: 'begrip', q: 'Wat is het **bullwhip-effect**?', a: 'Kleine schommelingen in de vraag worden **steeds groter** hoger in de keten.', more: 'Oorzaak: elke schakel bestelt "voor de zekerheid" wat extra.', quiz: [['cloze', 'Het ____-effect: kleine vraagschommelingen worden groter hoger in de keten.', ['bullwhip', 'zweepslag']], ['mcq', 'Wat versterkt het bullwhip-effect?', 'Bestellen in grote batches', 'Gedeelde vraaggegevens', 'Kleine, frequente leveringen', 'Vaste prijzen']] },
  { ch: 'SCM-H2', type: 'schema', q: 'Welke vier schakels toont het ketenschema?', a: '**Leverancier → producent → groothandel → klant.**', vis: ['SCM-H2/p004', [0.05, 0.2, 0.95, 0.85]], quiz: [['mcq', 'Welke schakel komt na de producent in het ketenschema?', 'Groothandel', 'Leverancier', 'Klant', 'Bank']] },
  { ch: 'SCM-H2', type: 'waarom', q: 'Waarom delen ketenpartners hun vraaggegevens?', a: 'Om het **bullwhip-effect te dempen**: iedereen plant op de echte vraag.', quiz: [['tf', 'Gedeelde vraaggegevens dempen het bullwhip-effect.', true]] },
  { ch: 'SCM-H2', type: 'begrip', q: 'Wat betekent **lead time**?', a: 'De **tijd tussen bestellen en ontvangen**.', quiz: [['cloze', 'De tijd tussen bestellen en ontvangen heet de ____.', ['lead time', 'levertijd']], ['tf', 'Lead time is de tijd die een product in de winkel ligt.', false, 'Lead time is de tijd tussen bestellen en ontvangen.']] },
  { ch: 'SCM-H2', type: 'begrip', q: 'Wat is een **push**-systeem?', a: 'Produceren **op voorspelling**, vóór er een bestelling is.', quiz: [['mcq', 'Wat kenmerkt een push-systeem?', 'Produceren op voorspelling', 'Produceren op bestelling', 'Geen voorraad', 'Alleen online verkoop']] },
  { ch: 'SCM-H2', type: 'begrip', q: 'Wat is een **pull**-systeem?', a: 'Produceren **op echte vraag**: pas na de bestelling.', quiz: [['tf', 'Bij pull wordt pas geproduceerd na een bestelling.', true]] },
  { ch: 'SCM-H2', type: 'casus', q: 'Een bakker bakt elke ochtend 200 broden op gevoel. Push of pull?', a: '**Push**: hij produceert op voorspelling.', quiz: [['mcq', 'Een bakker bakt elke ochtend 200 broden op gevoel. Welk systeem?', 'Push', 'Pull', 'Just-in-time', 'Cross-docking']] },
  // SCM H3 (being studied; holds the open session quiz)
  { ch: 'SCM-H3', type: 'begrip', q: 'Uit welke delen bestaat de **economische voorraad**?', a: '**Technische voorraad + bestelde voorraad − gereserveerde voorraad.**', vis: ['SCM-H3/p006', [0.08, 0.15, 0.92, 0.9]], quiz: [['mcq', 'Wat trek je af om de economische voorraad te krijgen?', 'Gereserveerde voorraad', 'Bestelde voorraad', 'Technische voorraad', 'Veiligheidsvoorraad'], ['cloze', 'Economische voorraad = technische + bestelde − ____ voorraad.', ['gereserveerde']]] },
  { ch: 'SCM-H3', type: 'begrip', q: 'Wat is **veiligheidsvoorraad**?', a: 'Extra voorraad tegen **onzekerheid** in vraag of levertijd.', quiz: [['tf', 'Veiligheidsvoorraad beschermt tegen onzekerheid in vraag of levertijd.', true], ['mcq', 'Waartegen beschermt veiligheidsvoorraad?', 'Onzekerheid in vraag of levertijd', 'Diefstal', 'Prijsstijgingen', 'Te volle magazijnen']] },
  { ch: 'SCM-H3', type: 'formule', q: 'Wat is de formule van de **EOQ** (economische bestelhoeveelheid)?', a: '**Q = √(2·D·Cb / Cv)**', more: 'D = jaarvraag, Cb = bestelkost per bestelling, Cv = voorraadkost per stuk per jaar.', vis: ['SCM-H3/p007', [0.1, 0.25, 0.9, 0.7]], quiz: [['mcq', 'Wat staat onder de wortel in de EOQ-formule?', '2·D·Cb / Cv', 'D·Cv / 2·Cb', '2·Cb / D', 'D / Cv'], ['cloze', 'EOQ: Q = √(2·D·____ / Cv)', ['Cb', 'bestelkost']]] },
  { ch: 'SCM-H3', type: 'rekenen', q: 'D = 8 000, Cb = € 50, Cv = € 2. Bereken de EOQ.', a: '**Q = √(2·8 000·50 / 2) = 632** stuks.', quiz: [['numeric', 'D = 8 000 stuks, Cb = € 50, Cv = € 2. Bereken de EOQ (afgerond).', 632, 'stuks', 1]] },
  { ch: 'SCM-H3', type: 'begrip', q: 'Wat is het **bestelpunt**?', a: 'Het voorraadniveau waarop je **opnieuw bestelt**: vraag tijdens levertijd + veiligheidsvoorraad.', quiz: [['tf', 'Het bestelpunt is het voorraadniveau waarop je opnieuw bestelt.', true], ['cloze', 'Bestelpunt = vraag tijdens de ____ + veiligheidsvoorraad.', ['levertijd', 'lead time']]] },
  { ch: 'SCM-H3', type: 'rekenen', q: 'Vraag 40 per dag, levertijd 5 dagen, veiligheidsvoorraad 60. Bestelpunt?', a: '**40 × 5 + 60 = 260** stuks.', quiz: [['numeric', 'Vraag 40 per dag, levertijd 5 dagen, veiligheidsvoorraad 60. Wat is het bestelpunt?', 260, 'stuks', 0]] },
  { ch: 'SCM-H3', type: 'begrip', q: 'Wat meet de **omloopsnelheid** van de voorraad?', a: 'Hoe vaak de voorraad **per jaar wordt vervangen**.', quiz: [['mcq', 'Wat meet de omloopsnelheid?', 'Hoe vaak de voorraad per jaar vervangen wordt', 'De waarde van de voorraad', 'De levertijd', 'Het aantal leveranciers']] },
  { ch: 'SCM-H3', type: 'waarom', q: 'Waarom is te veel voorraad duur?', a: 'Het **kapitaal ligt vast** en je betaalt opslag, verzekering en veroudering.', quiz: [['tf', 'Te veel voorraad kost niets zolang het niet verkocht is.', false, 'Voorraad bindt kapitaal en kost opslag, verzekering en veroudering.']] },
  { ch: 'SCM-H3', type: 'begrip', q: 'Wat is een **ABC-analyse**?', a: 'Artikelen indelen naar **belang (omzetwaarde)**: A = weinig artikelen, veel waarde.', quiz: [['mcq', 'Wat kenmerkt A-artikelen in een ABC-analyse?', 'Weinig artikelen, veel waarde', 'Veel artikelen, weinig waarde', 'Alleen dure artikelen', 'Artikelen zonder vraag']] },
  // FB H1
  { ch: 'FB-H1', type: 'begrip', q: 'Wat is **liquiditeit**?', a: 'Het vermogen om **kortetermijnschulden te betalen**.', quiz: [['mcq', 'Wat meet liquiditeit?', 'Kortetermijnschulden kunnen betalen', 'Winst maken', 'Eigen vermogen', 'Marktaandeel'], ['tf', 'Liquiditeit gaat over schulden op lange termijn.', false, 'Liquiditeit gaat over kortetermijnschulden.']] },
  { ch: 'FB-H1', type: 'formule', q: 'Hoe bereken je de **current ratio**?', a: '**Vlottende activa ÷ kortlopende schulden.**', quiz: [['cloze', 'Current ratio = vlottende activa ÷ ____ schulden.', ['kortlopende', 'kortetermijn']]] },
  { ch: 'FB-H1', type: 'rekenen', q: 'Vlottende activa € 150 000, kortlopende schulden € 100 000. Current ratio?', a: '**150 000 ÷ 100 000 = 1,5**', quiz: [['numeric', 'Vlottende activa € 150 000, kortlopende schulden € 100 000. Current ratio?', 1.5, '', 0.01]] },
  { ch: 'FB-H1', type: 'begrip', q: 'Wat is **solvabiliteit**?', a: 'Het vermogen om **alle schulden** te betalen, ook op lange termijn.', quiz: [['tf', 'Solvabiliteit kijkt ook naar schulden op lange termijn.', true]] },
  { ch: 'FB-H1', type: 'begrip', q: 'Wat is het verschil tussen **winst en cashflow**?', a: 'Winst is een **boekhoudresultaat**; cashflow is het **geld dat echt binnenkomt**.', quiz: [['mcq', 'Wat is cashflow?', 'Het geld dat echt binnenkomt en buitengaat', 'De winst na belastingen', 'Het eigen vermogen', 'De omzet']] },
  // BE U1 (cards only: Business English has no quizzes)
  { ch: 'BE-U1', type: 'vertaling', q: 'Vertaal: "de levertermijn"', a: '**the delivery time** (or: lead time)' },
  { ch: 'BE-U1', type: 'grammatica', q: 'Present simple or continuous: "We usually ___ (ship) on Mondays."', a: '**ship**: a habit takes the present simple.' },
  { ch: 'BE-U1', type: 'vertaling', q: 'Vertaal: "een offerte aanvragen"', a: '**to request a quotation**' },
  { ch: 'BE-U1', type: 'grammatica', q: 'Which is correct: "I look forward to hear / hearing from you"?', a: '**hearing**: "look forward to" + -ing.' },
  // BR, OR and IFHT: two cards each, so the demo shows all six courses.
  { ch: 'BR-H1', type: 'begrip', q: 'Wat is een **rechtsbron**?', a: 'Een **oorsprong van rechtsregels**: wet, gewoonte, rechtspraak en rechtsleer.', quiz: [['mcq', 'Welke van deze is een rechtsbron?', 'De wet', 'Een krantenartikel', 'Een offerte', 'Een factuur']] },
  { ch: 'BR-H1', type: 'begrip', q: 'Wat is het verschil tussen **dwingend** en **aanvullend** recht?', a: '**Dwingend recht** kan je niet opzijzetten; **aanvullend recht** wel, met een contract.', quiz: [['tf', 'Van aanvullend recht mag je in een contract afwijken.', true]] },
  { ch: 'OR-H1', type: 'begrip', q: 'Wie is een **onderneming** volgens het WER?', a: 'Elke **zelfstandige natuurlijke persoon**, elke **rechtspersoon** en elke andere organisatie zonder rechtspersoonlijkheid.', quiz: [['mcq', 'Wie is géén onderneming volgens het WER?', 'Een werknemer in loondienst', 'Een zelfstandige', 'Een nv', 'Een vzw']] },
  { ch: 'OR-H1', type: 'begrip', q: 'Wat is de **KBO**?', a: 'De **Kruispuntbank van Ondernemingen**: het register met elke onderneming en haar nummer.', quiz: [['cloze', 'De KBO is de Kruispuntbank van ____.', ['Ondernemingen']]] },
  { ch: 'IFHT-H1', type: 'begrip', q: 'Wat regelen de **Incoterms**?', a: '**Wie betaalt en wie het risico draagt** tijdens het transport van verkoper naar koper.', quiz: [['mcq', 'Wat regelen de Incoterms?', 'Kosten en risico tijdens het transport', 'De prijs van de goederen', 'De btw-tarieven', 'De betalingstermijn']] },
  { ch: 'IFHT-H1', type: 'begrip', q: 'Bij welke Incoterm draagt de koper **het meeste risico**?', a: '**EXW** (Ex Works): de koper haalt de goederen op bij de verkoper.', quiz: [['mcq', 'Bij welke Incoterm draagt de koper het meeste risico?', 'EXW', 'DDP', 'CIF', 'DAP']] },
];

const HINTS = (a: string): string[] => {
  const key = (/\*\*(.+?)\*\*/.exec(a)?.[1] ?? a).replace(/[*]/g, '');
  const words = key.split(/\s+/);
  return [
    'Denk aan wat je in de les over dit onderwerp zag.',
    `Het antwoord telt ${words.length} woord${words.length === 1 ? '' : 'en'}.`,
    `Het begint met: "${key.slice(0, Math.max(3, Math.floor(key.length / 3)))}…"`,
  ];
};

function makeItems(card: Card, specs: QuizSpec[], startN: number, created: string): QuizItem[] {
  return specs.map((s, i): QuizItem => {
    const base = {
      id: uid(2, startN + i),
      card_id: card.id,
      course_id: card.course_id,
      chapter_id: card.chapter_id,
      hint: card.hints[0],
      explanation: card.answer.core.replace(/\*\*/g, ''),
      source_label: card.source.label,
      status: 'live' as const,
      created_at: created,
      updated_at: created,
    };
    switch (s[0]) {
      case 'mcq':
        return {
          ...base,
          format: 'mcq',
          stem: s[1],
          options: [
            { text: s[2], correct: true, why: 'Dit is de definitie uit de les.' },
            { text: s[3], correct: false, why: 'Dat is maar een deel van het verhaal.' },
            { text: s[4], correct: false, why: 'Dit hoort bij een ander begrip.' },
            { text: s[5], correct: false, why: 'Dit heeft hier niets mee te maken.' },
          ],
          answer: null,
        };
      case 'tf':
        return {
          ...base,
          format: 'tf',
          stem: s[1],
          options: [
            { text: 'Juist', correct: s[2], why: s[2] ? 'Klopt.' : 'Nee: zie de correctie.' },
            { text: 'Fout', correct: !s[2], why: s[2] ? 'Toch wel juist.' : 'Klopt, de stelling is fout.' },
          ],
          answer: { correction: s[3] ?? null },
        };
      case 'cloze':
        return { ...base, format: 'cloze', stem: s[1], options: null, answer: { accept: s[2] } };
      case 'numeric':
        return {
          ...base,
          format: 'numeric',
          stem: s[1],
          options: null,
          answer: { value: s[2], unit: s[3] || null, tolerance: s[4], steps: [card.answer.core.replace(/\*\*/g, '')] },
        };
    }
  });
}

/* ------------------------------------------------------------------ *
 * Building the tables
 * ------------------------------------------------------------------ */

export function buildDemo(now: Date = new Date()): DemoTables {
  const today = studyDay(now);
  const day = (n: number) => addDays(today, n);
  const stamp = at(day(-20));

  const courses: Course[] = [
    { id: 'SCM', name: 'Supply Chain Management', color: '#2F6FEB', icon: 'truck', sort: 1, updated_at: stamp },
    { id: 'BR', name: 'Burgerlijk recht', color: '#D93F3F', icon: 'scales', sort: 2, updated_at: stamp },
    { id: 'OR', name: 'Ondernemingsrecht', color: '#8250DF', icon: 'building', sort: 3, updated_at: stamp },
    { id: 'FB', name: 'Financieel beheer van een bedrijf', color: '#1F9D55', icon: 'calculator', sort: 4, updated_at: stamp },
    { id: 'IFHT', name: 'Internationale financiële- en handelstechnieken', color: '#E8730C', icon: 'globe', sort: 5, updated_at: stamp },
    { id: 'BE', name: 'Business English 1', color: '#0F9AA8', icon: 'speech', sort: 6, updated_at: stamp },
  ];
  const chapter = (id: string, course: string, code: string, title: string, sort: number, status: Chapter['status']): Chapter => ({
    id, course_id: course, code, title, sort, notion_page_id: null, slide_numbering: 'position', status, updated_at: stamp,
  });
  const chapters: Chapter[] = [
    chapter('SCM-H2', 'SCM', 'H2', 'De supply chain', 2, 'af'),
    chapter('SCM-H3', 'SCM', 'H3', 'Voorraadbeheer', 3, 'bezig'),
    chapter('FB-H1', 'FB', 'H1', 'Liquiditeit en solvabiliteit', 1, 'bezig'),
    chapter('BE-U1', 'BE', 'U1', 'Unit 1: Doing business', 1, 'bezig'),
    chapter('BR-H1', 'BR', 'H1', 'Inleiding tot het recht', 1, 'af'),
    chapter('OR-H1', 'OR', 'H1', 'De onderneming', 1, 'bezig'),
    chapter('IFHT-H1', 'IFHT', 'H1', 'Incoterms', 1, 'bezig'),
  ];

  const slides: Slide[] = ['SCM-H2/p004', 'SCM-H3/p006', 'SCM-H3/p007'].map((key, i) => ({
    key, chapter_id: key.split('/')[0], page_idx: Number(key.slice(-3)), printed_no: String(10 + i * 7),
    image_path: `${key}.webp`, w: 2000, h: 1125, updated_at: stamp,
  }));

  const cards: Card[] = [];
  const items: QuizItem[] = [];
  const perChapter = new Map<string, number>();
  CARDS.forEach((spec, i) => {
    const course = spec.ch.split('-')[0];
    const sort = (perChapter.get(spec.ch) ?? 0) + 1;
    perChapter.set(spec.ch, sort);
    const code = spec.ch.split('-')[1];
    const label = course === 'BE' ? `BE · cursus p. ${10 + sort}` : `${course} ${code} · dia ${sort * 3 + 2}`;
    const visual = spec.vis ? { slide: spec.vis[0], crop: spec.vis[1], caption: 'Voorbeeldschema (demo)' } : null;
    const card: Card = {
      id: uid(1, i + 1), course_id: course, chapter_id: spec.ch, type: spec.type,
      front: { text: spec.q, visual: null },
      answer: { core: spec.a, more: spec.more ?? null, visual },
      hints: HINTS(spec.a),
      source: { label, slide: spec.vis?.[0] ?? null },
      exam_value: spec.type === 'rekenen' || spec.type === 'formule' ? 3 : 2,
      sibling_group: null, sort, legacy_notion_id: null, notion_inbox_id: null,
      status: 'live', version: 1,
      created_at: at(day(spec.ch === 'SCM-H3' && sort >= 3 ? -1 : -15)),
      updated_at: stamp,
    };
    cards.push(card);
    if (spec.quiz && course !== 'BE') items.push(...makeItems(card, spec.quiz, items.length + 1, card.created_at));
  });

  // Yesterday's self-study of SCM H3 (cards 3–9 of the chapter) with its open session quiz.
  const sessionCards = cards.filter((c) => c.chapter_id === 'SCM-H3' && c.sort >= 3);
  const session: StudySession = {
    id: uid(3, 1), session_key: `SCM-H3:${day(-1)}:12-26`, course_id: 'SCM', chapter_id: 'SCM-H3',
    kind: 'zelfstudie', title: 'SCM H3 · dia 12–26', card_ids: sessionCards.map((c) => c.id),
    created_at: at(day(-1), 16), updated_at: at(day(-1), 16),
  };
  const sessionItems: string[] = [];
  for (const round of [0, 1]) {
    for (const c of sessionCards) {
      const mine = items.filter((it) => it.card_id === c.id);
      if (mine[round] && sessionItems.length < 10) sessionItems.push(mine[round].id);
    }
  }
  const quizzes: Quiz[] = [{
    id: uid(4, 1), kind: 'sessie', session_id: session.id, course_id: 'SCM', chapter_id: 'SCM-H3',
    title: session.title, item_ids: sessionItems, created_at: session.created_at, updated_at: session.created_at,
  }];

  // Reviews: SCM H2 and FB studied two weeks ago, with a mix of results, so
  // some cards are due today and the boxes are spread out.
  const reviews: Review[] = [];
  let r = 0;
  const review = (cardId: string, d: string, result: Review['result'], hints = 0) => {
    reviews.push({
      id: uid(5, ++r), card_id: cardId, reviewed_at: at(d, 20), day: d, result,
      hints_used: hints, mode: 'sessie', undoes: null, ms: 9000 + (r % 7) * 1500,
    });
  };
  const older = cards.filter((c) => ['SCM-H2', 'FB-H1', 'BE-U1', 'BR-H1', 'OR-H1', 'IFHT-H1'].includes(c.chapter_id));
  older.forEach((c, i) => {
    review(c.id, day(-14), i % 4 === 3 ? 'niet' : 'gekend'); // → Doos 2 (or 1)
    if (i % 4 !== 3) review(c.id, day(-11), i % 3 === 0 ? 'hint' : 'gekend', i % 3 === 0 ? 1 : 0); // → Doos 2 or 3
    else review(c.id, day(-13), 'gekend'); // Doos 1 → 2
    if (i % 5 === 0) review(c.id, day(-4), 'gekend'); // a few move one box further
  });
  // A little activity this week for the bars on Home.
  for (let d = -6; d <= -1; d++) {
    const c = cards[(d + 6) % cards.length];
    if (d % 2 === 0) review(c.id, day(d), 'gekend');
  }
  // More of the past days, as herhaling answers: they fill the day bars and
  // the streak without moving any card to another box.
  for (let d = -9; d <= -1; d++) {
    const n = [6, 11, 4, 14, 9, 17, 12, 8, 15][d + 9];
    for (let k = 0; k < n; k++) {
      const c = cards[(k * 3 + d + 9) % cards.length];
      reviews.push({
        id: uid(11, ++r), card_id: c.id, reviewed_at: at(day(d), 21), day: day(d), result: 'gekend',
        hints_used: 0, mode: 'herhaling', undoes: null, ms: 7000 + (k % 5) * 2500,
      });
    }
  }

  // A chapter quiz of SCM H2 done last week (8/10), and one wrong answer.
  const attempts: QuizAttempt[] = [];
  const h2Items = items.filter((it) => it.chapter_id === 'SCM-H2').slice(0, 10);
  h2Items.forEach((it, i) => {
    attempts.push({
      id: uid(6, i + 1), run_id: uid(7, 1), item_id: it.id, card_id: it.card_id, scope: 'hoofdstuk:SCM-H2',
      correct: i % 5 !== 4, answer: { option: 0 }, hint_used: false, answered_at: at(day(-6), 21), day: day(-6),
    });
  });

  const dayPlans: DayPlan[] = [
    { day: today, course_order: ['SCM', 'FB'], reason: 'Eerst SCM: toets binnen drie weken', cap: null, new_max: null, reminder_at: '21:00', source: 'notion', updated_at: stamp },
    { day: day(1), course_order: ['FB', 'BE'], reason: 'Eerst FB: morgen les', cap: null, new_max: null, reminder_at: '21:00', source: 'notion', updated_at: stamp },
  ];

  const exams: Exam[] = [
    { id: uid(8, 1), course_id: 'SCM', kind: 'toets', day: day(20), end_day: null, chapter_ids: ['SCM-H2', 'SCM-H3'], title: 'Toets SCM H2–H3', updated_at: stamp },
  ];

  const instruments: Instrument[] = [
    { id: uid(9, 1), course_id: 'SCM', chapter_id: 'SCM-H3', title: 'Voorraadsoorten-tabel', notion_url: 'https://www.notion.so/', minutes: 12, status: 'live', updated_at: stamp },
    { id: uid(9, 2), course_id: 'FB', chapter_id: 'FB-H1', title: 'Ratio-overzicht', notion_url: null, minutes: 10, status: 'live', updated_at: stamp },
  ];
  const instrumentReviews: InstrumentReview[] = [
    { id: uid(10, 1), instrument_id: uid(9, 2), day: day(-1), score: 'alles', created_at: at(day(-1), 14) },
  ];

  const settings: Setting[] = [
    { key: 'goals', value: [
      { id: 'daily_queue', label: 'Vandaag je kaartjes afwerken', target: 1, unit: 'share' },
      { id: 'accuracy', label: 'Gemiddeld 80% juist', target: 0.8, unit: 'share' },
      { id: 'quizzes_week', label: '3 quizzen deze week', target: 3, unit: 'count' },
    ], updated_at: stamp },
    { key: 'defaults', value: { cap: 20, cap_sunday: 30, new_max: 10, new_max_sunday: 5, wait_days: [1, 3, 7, 14, 28, 60], est_sec_review: 15, est_sec_new: 30, reminder_at: '21:00' }, updated_at: stamp },
    { key: 'profile', value: { name: 'Mathieu', subtitle: 'Student' }, updated_at: stamp },
  ];

  const pipeline: PipelineStatus[] = [
    { id: 1, last_intake_at: at(day(-1), 20), last_intake_ok: true, message: 'Demo', updated_at: stamp },
  ];

  return {
    courses, chapters, study_sessions: [session], quizzes, exams, slides, cards, quiz_items: items,
    day_plan: dayPlans, instruments, settings, pipeline_status: pipeline,
    card_marks: [{ card_id: cards[10].id, starred: true, updated_at: stamp }],
    reviews, quiz_attempts: attempts, card_flags: [], instrument_reviews: instrumentReviews,
  };
}

/**
 * Fill a (memory) store with the demo. Rows go in as server rows, so nothing
 * lands in the outbox and nothing would ever be sent.
 */
export async function seedDemo(store: Store, now: Date = new Date()): Promise<void> {
  const demo = buildDemo(now);
  for (const table of Object.keys(demo) as TableName[]) {
    await store.accept(table, demo[table] as never[]);
  }
}
