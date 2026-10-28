/**
 * Discord requires required application-command parameters to precede optional
 * parameters within every subcommand. Builders do not validate this invariant
 * across all nested command groups, so enforce it before sending the REST payload.
 */
export interface CommandOptionPayload {
  required?: boolean;
  options?: CommandOptionPayload[];
  [key: string]: unknown;
}

function orderRequiredOptionsFirst(options: readonly CommandOptionPayload[]): CommandOptionPayload[] {
  const normalized = options.map((option) => {
    const copy: CommandOptionPayload = { ...option };
    if (Array.isArray(option.options)) {
      copy.options = orderRequiredOptionsFirst(option.options);
    }
    return copy;
  });

  // Groups contain subcommands, not argument options. Keep their declared order.
  if (!normalized.some((option) => typeof option.required === 'boolean')) {
    return normalized;
  }

  return normalized
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      const requiredOrder = Number(right.option.required === true) - Number(left.option.required === true);
      return requiredOrder || left.index - right.index;
    })
    .map(({ option }) => option);
}

export function normalizeRequiredOptionOrder<T extends CommandOptionPayload>(command: T): T {
  const normalized: CommandOptionPayload = { ...command };
  if (Array.isArray(command.options)) {
    normalized.options = orderRequiredOptionsFirst(command.options);
  }
  return normalized as T;
}
