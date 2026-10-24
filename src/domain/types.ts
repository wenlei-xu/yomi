export type UUID = string

export type ProviderProtocol = 'responses' | 'chat-completions'
export type ProviderChannelKind = 'text' | 'image' | 'speech'
export type ModelPurpose = 'main' | 'triage' | 'summary'
export type CredentialState = 'stored' | 'missing'
export type ActorKind = 'human' | 'agent'
export type ConversationKind = 'direct' | 'group' | 'agent_direct' | 'agent_group'

export interface ProviderModel {
  id: string
  name: string
  owner: string
}

export interface ModelTestResult {
  message: string
  latencyMs: number
  kind: 'image' | 'speech'
  dataUrl: string
}
export type RunStatus = 'queued' | 'triaging' | 'running' | 'completed' | 'skipped' | 'deferred' | 'failed' | 'cancelled' | 'interrupted'
export type InboxStatus = 'pending' | 'claimed' | 'handled' | 'skipped' | 'cancelled' | 'deferred'

export interface Provider {
  id: UUID
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  credentialRef: string
  credentialState: CredentialState
  enabled: boolean
  configVersion: number
  createdAt: number
  updatedAt: number
}

export interface ModelBinding {
  agentId?: UUID
  id: UUID
  providerId: UUID | null
  modelId: string
  contextTokens: number
  outputTokens: number
  purpose: ModelPurpose
  revision: number
}

export interface Actor {
  id: UUID
  kind: ActorKind
  name: string
  color: string
  bio: string
  persona: string
  speakingStyle: string
  greeting: string
  avatarData: string
  enabled: boolean
  archived: boolean
  profileVersion: number
  allowPrivate: boolean
  allowGroup: boolean
  createdAt: number
  updatedAt: number
}

export type AgentStatus = 'active' | 'disabled' | 'archived'

export interface AgentSettingsUpdate {
  privateMemo?: string
  modelBindings?: ModelBinding[]
}

export interface Conversation {
  id: UUID
  kind: ConversationKind
  title: string
  topic: string
  announcement?: string
  announcementUpdatedAt?: number
  members: string[]
  memberNames: string[]
  originConversationId: string | null
  pinned: boolean
  muted: boolean
  hidden: boolean
  paused: boolean
  autonomyPaused: boolean
  nextSequence: number
  contentRevision: number
  membershipVersion: number
  cancelEpoch: number
  createdAt: number
  updatedAt: number
  lastMessage: string
  unread: number
}

export interface Message {
  id: UUID
  conversationId: UUID
  authorId: string
  authorName: string
  authorKind: ActorKind | 'system'
  body: string
  sequence: number
  quotedId: UUID | null
  mentions: UUID[]
  createdAt: number
  recalled?: boolean
  editedAt?: number
  editHistory?: { body: string; at: number }[]
  deleted: boolean
  reactions: MessageReaction[]
  humanTriggered?: boolean
  humanReaction?: string
  commandReplayed?: boolean
  retryRunId?: string
  mediaId?: string | null
  sticker?: boolean
}

export interface MessageReaction {
  emoji: string
  actorIds: string[]
}

export interface Memory {
  id: UUID
  agentId: UUID
  conversationId: UUID | null
  body: string
  kind: string
  about: string
  pinned: boolean
  origin: 'human' | 'agent'
  createdAt: number
  updatedAt: number
}

export type ConversationNoteScope = 'shared' | 'private'

/** Group-level note written by the local user: shared with every agent, or about one member. */
export interface ConversationNote {
  id: UUID
  conversationId: UUID
  authorId: UUID
  scope: ConversationNoteScope
  targetActorId: UUID | null
  body: string
  version: number
  createdAt: number
  updatedAt: number
}

export interface SummarySpan {
  id: UUID
  startSequence: number
  throughSequence: number
  body: string
}

export interface SummaryEntry extends SummarySpan {
  kind: 'segment' | 'cumulative'
  cumulativeBody: string
  cumulativeStartSequence: number
  createdAt: number
  valid: boolean
}

export interface ConversationMemorySource {
  id: UUID
  title: string
  kind: ConversationKind
  linked: boolean
  available: boolean
}

/** Sources actually supplied to a run; checked again before any tool commits. */
export interface LinkedContextSource {
  conversationId: UUID
  contentRevision: number
  membershipVersion: number
  joinedSequence: number
  memoryVersions?: { id: UUID; version: number }[]
}

export type ProactiveMode = 'interval' | 'daily'

/** Local schedule that lets an agent speak without a new human message. */
export interface ProactiveRule {
  id: UUID
  conversationId: UUID
  actorId: UUID | null
  mode: ProactiveMode
  intervalMinutes: number
  dailyAt: number
  prompt: string
  enabled: boolean
  lastFiredAt: number
  nextDueAt: number
  createdAt: number
  updatedAt: number
}

export type LorebookScope = 'global' | 'conversation'

export interface Lorebook {
  id: UUID
  title: string
  description: string
  scope: LorebookScope
  conversationId: UUID | null
  enabled: boolean
  entryCount: number
  createdAt: number
  updatedAt: number
}

export interface LorebookEntry {
  id: UUID
  lorebookId: UUID
  title: string
  content: string
  keywords: string[]
  enabled: boolean
  constant: boolean
  secondaryKeywords: string[]
  selective: boolean
  caseSensitive: boolean
  ordinal: number
  sourceJson: string
  createdAt: number
  updatedAt: number
}

export type MediaKind = 'image' | 'audio'

export interface MediaAsset {
  id: UUID
  kind: MediaKind
  ownerActorId: UUID | null
  conversationId: UUID | null
  messageId: UUID | null
  providerId: string
  modelId: string
  prompt: string
  status: 'pending' | 'ready' | 'failed'
  error: string
  bytes: number
  mimeType: string
  width: number
  height: number
  durationMs: number
  transcript: string
  voice: string
  createdAt: number
}

export interface Sticker {
  id: UUID
  name: string
  dataUrl: string
  createdAt: number
  contentHash?: string
  analysisStatus?: 'pending' | 'analyzing' | 'ready' | 'failed'
  analysis?: StickerMeaning | null
  analysisError?: string
  analysisToken?: string
}

export interface StickerMeaning {
  description: string
  text: string
  tags: string[]
  situations: string[]
}

export interface StickerRecognitionSettings {
  enabled: boolean
  providerId: string
  modelId: string
  consentedOrigin: string
  revision: number
}

export const defaultStickerRecognitionSettings: StickerRecognitionSettings = {
  enabled: false, providerId: '', modelId: '', consentedOrigin: '', revision: 0
}

export interface MediaSettings {
  imageProviderId: string
  imageModel: string
  speechProviderId: string
  speechModel: string
  voice: string
}

export const defaultMediaSettings: MediaSettings = {
  imageProviderId: '', imageModel: '', speechProviderId: '', speechModel: '', voice: 'alloy'
}

export interface SearchHit extends Message {
  conversationTitle: string
}

export interface RuntimeView {
  streaming?: { agentId: string; conversationId: string; text: string }[]
  running: { agentId: string; conversationId: string; phase: string }[]
  waiting: RetryJob[]
}

export interface RetryJob {
  id: string; agentId: string; conversationId: string; runId: string
  dueAt: number; attempt: number; kind: 'rate' | 'http'
}

export interface RoutingPlan {
  mode: 'each' | 'one-of-us' | 'mention'
  targets: string[]
  tried: string[]
}

export interface ModelCallRecord {
  id: UUID
  runId: string
  agentId: string
  providerId: string
  modelId: string
  purpose: ModelPurpose | 'sticker-analysis'
  status: string
  inputTokens: number | null
  outputTokens: number | null
  errorCode: string
  startedAt: number
  endedAt: number | null
}

export interface RuntimeIssue {
  conversationId: UUID
  conversationTitle: string
  status: 'interrupted' | 'failed'
  reason: string
  updatedAt: number
}

export interface UsageSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  unknownCalls: number
  purposes: { purpose: string; calls: number; tokens: number }[]
}

export interface StorageStats {
  bytes: number; freeBytes: number
  messages: number; agents: number; conversations: number; memories: number; logs: number
  media: number; lorebooks: number
}

export interface ModelUsage {
  inputTokens: number | null
  outputTokens: number | null
}

export interface ModelResult {
  text: string
  toolCalls: ToolCall[]
  usage: ModelUsage
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ModelRequest {
  instructions: string
  input: ModelInputItem[]
  tools?: ToolDefinition[]
  maxOutputTokens?: number
}

export type ModelInputItem =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}
