export interface PlanPolicyViolation {
  readonly id: string;
  readonly path: string;
  readonly line: number;
}

export interface PlanPolicyResult {
  readonly files: readonly string[];
  readonly violations: readonly PlanPolicyViolation[];
}

export function scanPlanPolicy(options?: Readonly<{
  packageRoot?: string;
  sourceRoots?: readonly string[];
}>): Promise<PlanPolicyResult>;
