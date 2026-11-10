/** Domain identity, not the HTTP mapping descriptor exported as `Entity`. */
export interface IEntity {
  readonly id: string;
}

/** A fact's identity, stable wire name and ISO creation instant; delivery state is separate. */
export interface IDomainEvent extends IEntity {
  readonly name: string;
  readonly createdAt: string;
}
