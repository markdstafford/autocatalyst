import type {
  ConfigurationRecord,
  ModelRoutingErrorCode,
  ModelRoutingTableSettings,
  ModelRoutingEntry,
  SessionRole,
  ModelIdentity
} from '@autocatalyst/api-contract';
import { sessionRoleSchema } from '@autocatalyst/api-contract';
import type {
  AgentProviderAdapterRegistry,
  DirectProviderAdapterRegistry,
  ResolvedAgentCredentialReference,
  ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import { getAgentProviderAdapterKey } from '@autocatalyst/execution';

// Safe details (no secrets, prompts, raw settings JSON, transcripts)
export interface ModelRoutingSafeDetails {
  readonly tenant?: string;
  readonly runId?: string;
  readonly routingTableId?: string;
  readonly routeId?: string;
  readonly step?: string;
  readonly role?: SessionRole;
  readonly roles?: readonly SessionRole[];
  readonly mode?: 'agent' | 'direct';
  readonly distinctBy?: 'model' | 'profile';
  readonly profileId?: string;
  readonly profileName?: string;
  readonly providerKind?: string;
  readonly adapterId?: string;
  readonly model?: ModelIdentity;
  readonly collided?: readonly {
    readonly role: SessionRole;
    readonly profileId: string;
    readonly providerKind: string;
    readonly model: ModelIdentity;
  }[];
}

export class ModelRoutingConfigurationError extends Error {
  readonly code: ModelRoutingErrorCode;
  readonly safeDetails?: ModelRoutingSafeDetails;

  constructor(code: ModelRoutingErrorCode, message: string, safeDetails?: ModelRoutingSafeDetails) {
    super(message);
    this.name = 'ModelRoutingConfigurationError';
    this.code = code;
    if (safeDetails !== undefined) {
      this.safeDetails = safeDetails;
    }
  }
}

export interface ModelRoutingConfigurationReader {
  listConfigurationRecords(tenant: string): Promise<readonly ConfigurationRecord[]>;
  findConfigurationRecordById(tenant: string, id: string): Promise<ConfigurationRecord | null>;
}

export interface ResolveAgentRouteInput {
  readonly tenant: string;
  readonly runId?: string;
  readonly step: string;
  readonly role: SessionRole;
}

export interface ResolveDirectRouteInput {
  readonly tenant: string;
  readonly runId?: string;
  readonly step: string;
}

export interface ResolveDistinctAgentRoutesInput {
  readonly tenant: string;
  readonly runId?: string;
  readonly step: string;
  readonly roles: readonly SessionRole[];
  readonly distinctBy?: 'model' | 'profile';
}

export interface ModelRoutingResolution {
  readonly profile: ResolvedAgentRunnerProfile;
  readonly credentialReference: ResolvedAgentCredentialReference;
  readonly routeId: string;
  readonly profileId: string;
  readonly routingTableId: string;
}

export interface ModelRoutingDistinctResolution {
  readonly step: string;
  readonly distinctBy: 'model' | 'profile';
  readonly resolutionsByRole: Readonly<Record<SessionRole, ModelRoutingResolution>>;
}

export interface ModelRoutingResolver {
  resolveAgentRoute(input: ResolveAgentRouteInput): Promise<ModelRoutingResolution>;
  resolveDirectRoute(input: ResolveDirectRouteInput): Promise<ModelRoutingResolution>;
  resolveDistinctAgentRoutes(input: ResolveDistinctAgentRoutesInput): Promise<ModelRoutingDistinctResolution>;
}

export interface CreateModelRoutingResolverOptions {
  readonly configuration: ModelRoutingConfigurationReader;
  readonly agentAdapters: AgentProviderAdapterRegistry;
  readonly directAdapters: DirectProviderAdapterRegistry;
  readonly validateCredentialReference?: (input: {
    tenant: string;
    profile: ResolvedAgentRunnerProfile;
    credentialReference: ResolvedAgentCredentialReference;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadActiveRoutingTable(
  options: CreateModelRoutingResolverOptions,
  tenant: string,
  runId?: string
): Promise<{ table: ModelRoutingTableSettings; tableId: string }> {
  const records = await options.configuration.listConfigurationRecords(tenant);
  const activeTables = records.filter(
    (record) => record.kind === 'model_routing_table' && record.settings.active === true
  );
  if (activeTables.length === 0) {
    throw new ModelRoutingConfigurationError(
      'routing_table_missing',
      'No active model-routing table for tenant.',
      { tenant, ...(runId !== undefined ? { runId } : {}) }
    );
  }
  if (activeTables.length > 1) {
    throw new ModelRoutingConfigurationError(
      'routing_table_ambiguous',
      'Multiple active model-routing tables for tenant.',
      { tenant, ...(runId !== undefined ? { runId } : {}) }
    );
  }
  const tableRecord = activeTables[0]!;
  return { table: tableRecord.settings as ModelRoutingTableSettings, tableId: tableRecord.id };
}

function matchesAgentExact(entry: ModelRoutingEntry, step: string, role: SessionRole): boolean {
  return (
    entry.enabled !== false &&
    entry.route.mode === 'agent' &&
    entry.route.step === step &&
    !('defaultForStep' in entry.route && entry.route.defaultForStep === true) &&
    'role' in entry.route &&
    entry.route.role === role
  );
}

function matchesAgentDefault(entry: ModelRoutingEntry, step: string): boolean {
  return (
    entry.enabled !== false &&
    entry.route.mode === 'agent' &&
    entry.route.step === step &&
    'defaultForStep' in entry.route &&
    entry.route.defaultForStep === true
  );
}

function matchesDirect(entry: ModelRoutingEntry, step: string): boolean {
  return entry.enabled !== false && entry.route.mode === 'direct' && entry.route.step === step;
}

function selectSingleRoute(
  matches: ModelRoutingEntry[],
  errorDetails: ModelRoutingSafeDetails
): ModelRoutingEntry {
  if (matches.length === 0) {
    throw new ModelRoutingConfigurationError(
      'route_not_found',
      'No route found for the requested key.',
      errorDetails
    );
  }
  if (matches.length > 1) {
    throw new ModelRoutingConfigurationError(
      'duplicate_route',
      'Multiple enabled routes match the same key.',
      errorDetails
    );
  }
  const [only] = matches;
  return only!;
}

async function resolveEntryToProfile(
  options: CreateModelRoutingResolverOptions,
  entry: ModelRoutingEntry,
  routingTableId: string,
  mode: 'agent' | 'direct',
  tenant: string,
  runId?: string
): Promise<ModelRoutingResolution> {
  // Load the provider-profile record
  const profileRecord = await options.configuration.findConfigurationRecordById(tenant, entry.profileId);
  if (profileRecord === null || profileRecord.kind !== 'provider_profile') {
    throw new ModelRoutingConfigurationError(
      'profile_not_found',
      'Referenced provider-profile record not found.',
      { tenant, ...(runId !== undefined ? { runId } : {}), routingTableId, routeId: entry.id, profileId: entry.profileId, mode }
    );
  }

  const profileSettings = profileRecord.settings;

  // Validate completeness
  if (!profileSettings.model) {
    throw new ModelRoutingConfigurationError(
      'profile_incomplete',
      'Provider profile is missing explicit model.',
      {
        tenant,
        ...(runId !== undefined ? { runId } : {}),
        routingTableId,
        routeId: entry.id,
        profileId: entry.profileId,
        ...(profileSettings.profileName !== undefined ? { profileName: profileSettings.profileName } : {})
      }
    );
  }
  if (profileSettings.inferenceSettings === undefined) {
    throw new ModelRoutingConfigurationError(
      'profile_incomplete',
      'Provider profile is missing explicit inferenceSettings.',
      {
        tenant,
        ...(runId !== undefined ? { runId } : {}),
        routingTableId,
        routeId: entry.id,
        profileId: entry.profileId,
        ...(profileSettings.profileName !== undefined ? { profileName: profileSettings.profileName } : {})
      }
    );
  }
  if (profileSettings.endpoint === undefined) {
    throw new ModelRoutingConfigurationError(
      'profile_incomplete',
      'Provider profile is missing explicit endpoint settings.',
      {
        tenant,
        ...(runId !== undefined ? { runId } : {}),
        routingTableId,
        routeId: entry.id,
        profileId: entry.profileId,
        ...(profileSettings.profileName !== undefined ? { profileName: profileSettings.profileName } : {})
      }
    );
  }
  if (profileSettings.credentialSecretHandle === undefined) {
    throw new ModelRoutingConfigurationError(
      'profile_incomplete',
      'Provider profile is missing credential reference.',
      {
        tenant,
        ...(runId !== undefined ? { runId } : {}),
        routingTableId,
        routeId: entry.id,
        profileId: entry.profileId,
        ...(profileSettings.profileName !== undefined ? { profileName: profileSettings.profileName } : {})
      }
    );
  }

  // Look up adapter in the mode-specific registry
  const adapterKey = getAgentProviderAdapterKey(profileRecord.providerKind, profileRecord.adapterId);

  let connectionMechanism: 'fetch_transport' | 'process_environment';
  if (mode === 'agent') {
    const adapter = options.agentAdapters.get(adapterKey);
    if (!adapter) {
      // Check if it exists only in the direct registry (route_mode_mismatch)
      const directAdapter = options.directAdapters.get(adapterKey);
      if (directAdapter) {
        throw new ModelRoutingConfigurationError(
          'route_mode_mismatch',
          'Agent route references a profile that is only available as a direct adapter.',
          {
            tenant,
            ...(runId !== undefined ? { runId } : {}),
            routingTableId,
            routeId: entry.id,
            profileId: entry.profileId,
            providerKind: profileRecord.providerKind,
            adapterId: profileRecord.adapterId
          }
        );
      }
      throw new ModelRoutingConfigurationError(
        'adapter_unavailable',
        'No agent adapter registered for provider/adapter.',
        {
          tenant,
          ...(runId !== undefined ? { runId } : {}),
          routingTableId,
          routeId: entry.id,
          profileId: entry.profileId,
          providerKind: profileRecord.providerKind,
          adapterId: profileRecord.adapterId
        }
      );
    }
    connectionMechanism = adapter.supportedConnectionMechanism;
  } else {
    const adapter = options.directAdapters.get(adapterKey);
    if (!adapter) {
      // Check if it exists only in the agent registry (route_mode_mismatch)
      const agentAdapter = options.agentAdapters.get(adapterKey);
      if (agentAdapter) {
        throw new ModelRoutingConfigurationError(
          'route_mode_mismatch',
          'Direct route references a profile that is only available as an agent adapter.',
          {
            tenant,
            ...(runId !== undefined ? { runId } : {}),
            routingTableId,
            routeId: entry.id,
            profileId: entry.profileId,
            providerKind: profileRecord.providerKind,
            adapterId: profileRecord.adapterId
          }
        );
      }
      throw new ModelRoutingConfigurationError(
        'adapter_unavailable',
        'No direct adapter registered for provider/adapter.',
        {
          tenant,
          ...(runId !== undefined ? { runId } : {}),
          routingTableId,
          routeId: entry.id,
          profileId: entry.profileId,
          providerKind: profileRecord.providerKind,
          adapterId: profileRecord.adapterId
        }
      );
    }
    connectionMechanism = adapter.supportedConnectionMechanism;
  }

  // Build the resolved profile
  const profile: ResolvedAgentRunnerProfile = {
    mode,
    providerKind: profileRecord.providerKind,
    adapterId: profileRecord.adapterId,
    profileName: profileSettings.profileName,
    configurationRecordId: profileRecord.id,
    model: profileSettings.model,
    inferenceSettings: profileSettings.inferenceSettings,
    endpoint: profileSettings.endpoint,
    connectionMechanism
  };

  // Build credential reference
  const authTarget: 'header' | 'process_environment' =
    connectionMechanism === 'fetch_transport' ? 'header' : 'process_environment';

  const credentialReference: ResolvedAgentCredentialReference = {
    required: true,
    secretHandle: profileSettings.credentialSecretHandle,
    authTarget
  };

  // Validate credential reference if validator is provided
  if (options.validateCredentialReference) {
    try {
      await options.validateCredentialReference({ tenant, profile, credentialReference });
    } catch {
      throw new ModelRoutingConfigurationError(
        'credential_reference_invalid',
        'Credential reference validation failed.',
        {
          tenant,
          ...(runId !== undefined ? { runId } : {}),
          routingTableId,
          routeId: entry.id,
          profileId: entry.profileId,
          ...(profileSettings.profileName !== undefined ? { profileName: profileSettings.profileName } : {}),
          providerKind: profileRecord.providerKind,
          adapterId: profileRecord.adapterId
        }
      );
    }
  }

  return {
    profile,
    credentialReference,
    routeId: entry.id,
    profileId: entry.profileId,
    routingTableId
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createModelRoutingResolver(options: CreateModelRoutingResolverOptions): ModelRoutingResolver {
  return {
    async resolveAgentRoute(input: ResolveAgentRouteInput): Promise<ModelRoutingResolution> {
      const parsed = sessionRoleSchema.safeParse(input.role);
      if (!parsed.success) {
        throw new ModelRoutingConfigurationError(
          'route_not_found',
          'Invalid session role format.',
          { tenant: input.tenant, ...(input.runId !== undefined ? { runId: input.runId } : {}), step: input.step, mode: 'agent' }
        );
      }

      const { table, tableId } = await loadActiveRoutingTable(options, input.tenant, input.runId);
      const errorDetails: ModelRoutingSafeDetails = {
        tenant: input.tenant,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        step: input.step,
        role: input.role,
        mode: 'agent',
        routingTableId: tableId
      };

      // Try exact match first
      const exactMatches = table.entries.filter((e) => matchesAgentExact(e, input.step, input.role));
      let entry: ModelRoutingEntry;
      if (exactMatches.length > 0) {
        entry = selectSingleRoute(exactMatches, errorDetails);
      } else {
        // Fall back to step-level default
        const defaultMatches = table.entries.filter((e) => matchesAgentDefault(e, input.step));
        entry = selectSingleRoute(defaultMatches, errorDetails);
      }

      return resolveEntryToProfile(options, entry, tableId, 'agent', input.tenant, input.runId);
    },

    async resolveDirectRoute(input: ResolveDirectRouteInput): Promise<ModelRoutingResolution> {
      const { table, tableId } = await loadActiveRoutingTable(options, input.tenant, input.runId);
      const errorDetails: ModelRoutingSafeDetails = {
        tenant: input.tenant,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        step: input.step,
        mode: 'direct',
        routingTableId: tableId
      };

      const matches = table.entries.filter((e) => matchesDirect(e, input.step));
      const entry = selectSingleRoute(matches, errorDetails);

      return resolveEntryToProfile(options, entry, tableId, 'direct', input.tenant, input.runId);
    },

    async resolveDistinctAgentRoutes(input: ResolveDistinctAgentRoutesInput): Promise<ModelRoutingDistinctResolution> {
      const { table, tableId } = await loadActiveRoutingTable(options, input.tenant, input.runId);

      // Check for table-defined RoleDistinctRequirement for this step
      const tableRequirement = table.roleDistinctRequirements?.find(
        (req) => req.step === input.step && req.mode === 'agent'
      );

      // Table-defined requirement overrides caller distinctBy
      const distinctBy: 'model' | 'profile' = tableRequirement?.distinctBy ?? input.distinctBy ?? 'model';

      // Deduplicate to avoid phantom collisions from repeated roles
      const roles = [...new Set(input.roles)];

      // Resolve each role
      const resolutionsByRole: Record<SessionRole, ModelRoutingResolution> = {};
      for (const role of roles) {
        const errorDetails: ModelRoutingSafeDetails = {
          tenant: input.tenant,
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          step: input.step,
          role,
          mode: 'agent',
          routingTableId: tableId
        };

        const exactMatches = table.entries.filter((e) => matchesAgentExact(e, input.step, role));
        let entry: ModelRoutingEntry;
        if (exactMatches.length > 0) {
          entry = selectSingleRoute(exactMatches, errorDetails);
        } else {
          const defaultMatches = table.entries.filter((e) => matchesAgentDefault(e, input.step));
          entry = selectSingleRoute(defaultMatches, errorDetails);
        }

        const resolution = await resolveEntryToProfile(
          options,
          entry,
          tableId,
          'agent',
          input.tenant,
          input.runId
        );
        resolutionsByRole[role] = resolution;
      }

      // Check distinctness
      const getDistinctKey = (resolution: ModelRoutingResolution): string => {
        if (distinctBy === 'profile') {
          return resolution.profileId;
        }
        // 'model' distinctness: compare provider + model
        return `${resolution.profile.providerKind}:${resolution.profile.model.model}`;
      };

      const seenKeys = new Set<string>();
      const collided: Array<{
        role: SessionRole;
        profileId: string;
        providerKind: string;
        model: ModelIdentity;
      }> = [];

      for (const role of roles) {
        const resolution = resolutionsByRole[role]!;
        const key = getDistinctKey(resolution);
        if (seenKeys.has(key)) {
          collided.push({
            role,
            profileId: resolution.profileId,
            providerKind: resolution.profile.providerKind,
            model: resolution.profile.model
          });
        }
        seenKeys.add(key);
      }

      if (collided.length > 0) {
        throw new ModelRoutingConfigurationError(
          'role_distinct_unsatisfied',
          'Resolved roles do not satisfy the distinct-model requirement.',
          {
            tenant: input.tenant,
            ...(input.runId !== undefined ? { runId: input.runId } : {}),
            step: input.step,
            roles: input.roles,
            distinctBy,
            collided
          }
        );
      }

      return {
        step: input.step,
        distinctBy,
        resolutionsByRole
      };
    }
  };
}
