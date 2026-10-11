// The roles an app has and what each may do. The app names both: this package knows neither.

/** Each role and the permissions it holds. */
export type RoleMap = Readonly<Record<string, readonly string[]>>;

export type RoleOf<R extends RoleMap> = keyof R & string;
export type PermissionOf<R extends RoleMap> = R[keyof R][number];

export type Roles<R extends RoleMap> = {
  /** Every role, in the order the app wrote them. */
  readonly names: readonly RoleOf<R>[];
  /** Whether `value` is one of the roles. A claim or a request's field is `unknown` until this says so. */
  isRole(value: unknown): value is RoleOf<R>;
  can(role: RoleOf<R>, permission: PermissionOf<R>): boolean;
  /** The roles that hold `permission`. */
  holders(permission: PermissionOf<R>): readonly RoleOf<R>[];
};

/**
 * The app's roles. A route asks for one permission, and the role in the verified session either holds it
 * or the route answers 403.
 *
 *     const roles = defineRoles({
 *       admin: ["read", "write", "members.manage"],
 *       member: ["read", "write"],
 *       viewer: ["read"],
 *     });
 */
export function defineRoles<const R extends RoleMap>(map: R): Roles<R> {
  const names = Object.keys(map) as RoleOf<R>[];
  if (names.length === 0) throw new Error("defineRoles needs at least one role");
  const held = new Map(names.map((name) => [name, new Set<string>(map[name])]));
  const isRole = (value: unknown): value is RoleOf<R> =>
    typeof value === "string" && held.has(value as RoleOf<R>);
  const can = (role: RoleOf<R>, permission: PermissionOf<R>) =>
    held.get(role)?.has(permission) ?? false;
  return {
    names,
    isRole,
    can,
    holders: (permission) => names.filter((name) => can(name, permission)),
  };
}
