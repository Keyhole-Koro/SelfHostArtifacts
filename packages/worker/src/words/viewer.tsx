import type { Child } from "hono/jsx";

/** The words of the page screen (its bar, side panel and menus), kept in one place. */
export const VIEWER = {
  sideToggle: "Pages in this project",
  site: "Artifacts",
  search: "Search pages",
  whereThisIs: "Where this page is",
  allPages: "All pages",
  activity: "Activity",
  projects: "Projects",
  switchProject: "Go to another project",
  noProject: "Pages without a project",
  frontPage: (p: string) => `${p}: front page`,
  created: (when: Child, who: string): Child => (
    <>
      Created {when} by {who}
    </>
  ),
  updated: (when: Child, who: string): Child => (
    <>
      Updated {when} by {who}
    </>
  ),
  oldVersion: (n: number, latest: number) => `Version ${n} of ${latest}`,
  showLatest: "Show the latest",
  newer: (n: number | string, by: string) => `${by} saved version ${n} · show it`,
  editing: (names: string) => `${names} editing`,
  newerTitle: "A newer version was saved after you opened this page",
  external: "external",
  externalTitle: (hosts: string) => `May connect to ${hosts}`,
  publicBadge: "public link",
  publicTitle: "Anyone with the public link can read this page",
  restricted: "restricted",
  restrictedView: "Only some people can view this page",
  restrictedEdit: "Only some people can edit this page",
  edit: "Edit",
  editTitle: "Edit this page",
  editSource: "Edit HTML",
  editSourceTitle: "Change this page's HTML, with a preview",
  watch: "Watch",
  watching: "Watching",
  watchTitle: "Tell me about changes and comments on this page (in the bell)",
  stopTitle: "Stop telling me about this page",
  watchingProject: (p: string) => `Watching all of ${p}`,
  watchingProjectTitle: (p: string) => `You watch every page in ${p}. Stop it on the project's page.`,
  comments: "Comments",
  openThreads: (n: number) => `${n} open ${n === 1 ? "thread" : "threads"}`,
  history: "History",
  latest: "latest",
  changes: "changes",
  compare: "Compare versions…",
  more: "More",
  newPage: "New page",
  under: "Under this page",
  beside: "Beside this page",
  title: "Title",
  newTitle: "Title of the new page",
  startWriting: "Start writing",
  labels: "Labels",
  move: "Move",
  who: "Who can see and edit",
  publicLink: "Public link",
  linked: (n: number) => `Linked pages (${n})`,
  linkedFrom: "Linked from",
  linksTo: "Links to",
  copyLink: "Copy link",
  copied: "Copied",
  copyTitle: "Copy this page's address. Only people who can sign in here can open it.",
  newTab: "Open in a new tab",
  newTabTitle: "Only the page, without this bar",
  selection: "Comment on the selection",
};

/** Who saved a version or did something: a person, or an agent and whose it is. */
export const WHO = {
  agent: (owner: string, device: string) => `${owner}'s agent (${device})`,
  someone: "someone",
};

/** The comments beside a page. */
export const COMMENTS = {
  heading: "Comments",
  placeholder: "Comment on this page, or select a passage in it first",
  hint: "Select text in the page to comment on that passage.",
  submit: "Comment",
  none: "No comments yet.",
  onVersion: (n: number) => `on version ${n}`,
  showPassage: "Show this passage in the page",
  reply: "Reply",
  sendReply: "Reply",
  resolve: "Resolve",
  reopen: "Reopen",
  resolved: (n: number) => `Resolved (${n})`,
  delete: "Delete",
  deleteThread: "Delete this thread and its replies?",
  deleteReply: "Delete this reply?",
  newComment: "New comment",
};

/** The panels in the page's ⋯ menu. */
export const PANELS = {
  // Public link
  shareOn: "Anyone with this link can read the latest version without signing in.",
  shareBypass: "It skips this page's restrictions and the project's members-only setting.",
  copy: "Copy",
  openUntil: (date: Child, left: string): Child => (
    <>
      Open until {date} ({left}).
    </>
  ),
  daysLeft: (n: number) => (n <= 1 ? "less than a day left" : `${n} days left`),
  extend: (n: number) => `Extend ${n} days`,
  newLink: "New link",
  turnOff: "Turn off",
  shareOff: (n: number) => `Make a link that anyone can open without signing in, for ${n} days. They see only the latest version, not the list or older versions.`,
  create: "Create public link",
  publicLinkLabel: "Public link",
  // Who can see and edit
  modeOpen: "No restriction",
  modeOpenNote: "Everyone who can see the project reads it; its editors change it.",
  modeEdit: "Limit editing",
  modeEditNote: "Everyone who can see the project reads it; only the people below change it.",
  modeView: "Limit viewing",
  modeViewNote: "Only the people below see it, and the pages under it.",
  save: "Save",
  people: "People",
  canEdit: "can edit",
  canView: "can view",
  takeOff: (name: string) => `Take ${name} off`,
  person: "Person",
  whatTheyMay: "What they may do",
  add: "Add",
  ownerAlways: "The owner always sees and changes every page.",
  above: "The pages above it restrict it too:",
  aboveView: "only some can view",
  aboveEdit: "only some can edit",
  // Labels
  labelsNone: "No labels yet. A label groups pages across projects, like “decision” or “design”.",
  remove: (l: string) => `Remove the label ${l}`,
  labelsAdd: "Labels to add, separated by commas",
  labelsPlaceholder: "decision, design",
  labelsUsed: "Used on other pages:",
  // Move
  placeIn: (p: string) => `Place in ${p}`,
  parent: "Put this page under",
  top: (p: string) => `Top of ${p} (under no page)`,
  putUnder: "Move here",
  earlier: "↑ Up",
  later: "↓ Down",
  project: "Project",
  inProject: (p: string) => `In ${p}, with the pages under it. Move them to another project:`,
  noProjectYet: "Not in a project. Put it in one:",
  newProject: "New project…",
  moveTo: "Move",
  removeFrom: (p: string) => `Take it out of ${p}`,
  // Templates
  template: "Start from a template",
  projectTemplates: "This project's templates",
};
