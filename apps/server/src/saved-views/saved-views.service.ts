import { ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { type DataStore, type SavedView, type User } from '@argus/data';
import { hasPermission, MAX_SAVED_VIEWS, type Permission, type SavedViewCreateInput, type SavedViewDto, type SavedViewPage } from '@argus/shared';
import { DATA_STORE } from '../core/tokens';

/** What a user needs to see each list. */
const READ: Record<SavedViewPage, Permission> = { tickets: 'tickets:read', findings: 'findings:read' };
/** Sharing a view with everyone, or deleting someone else's shared view, is for people who run triage. */
const SHARE: Permission = 'tickets:triage';

/** Named list filters. A view stores only a query string: each viewer's own access still decides what they see. */
@Injectable()
export class SavedViewsService {
  constructor(@Inject(DATA_STORE) private readonly store: DataStore) {}

  async list(page: SavedViewPage, user: User): Promise<SavedViewDto[]> {
    this.assertCanRead(page, user);
    const views = await this.store.savedViews.listVisible(user.id, page);
    const owners = new Map<string, string | null>();
    for (const id of new Set(views.map((v) => v.userId))) owners.set(id, (await this.store.users.findById(id))?.displayName ?? null);
    return views.map((v) => this.toDto(v, user, owners.get(v.userId) ?? null));
  }

  async create(input: SavedViewCreateInput, user: User): Promise<SavedViewDto> {
    this.assertCanRead(input.page, user);
    if (input.shared && !hasPermission(user.role, SHARE)) throw new ForbiddenException('Only security managers and administrators can share views.');
    if ((await this.store.savedViews.countForUser(user.id, input.page)) >= MAX_SAVED_VIEWS) {
      throw new UnprocessableEntityException(`You can keep up to ${MAX_SAVED_VIEWS} views per list. Delete one first.`);
    }
    const view = await this.store.savedViews.create({ userId: user.id, page: input.page, name: input.name, query: input.query, shared: input.shared });
    return this.toDto(view, user, user.displayName);
  }

  async delete(id: string, user: User): Promise<void> {
    const view = await this.store.savedViews.findById(id);
    // Other people's private views are reported as missing rather than forbidden.
    if (!view || (view.userId !== user.id && !view.shared)) throw new NotFoundException('Saved view not found.');
    if (view.userId !== user.id && !hasPermission(user.role, SHARE)) throw new ForbiddenException('Only its owner, a security manager or an administrator can delete a shared view.');
    await this.store.savedViews.delete(id);
  }

  private assertCanRead(page: SavedViewPage, user: User): void {
    if (!hasPermission(user.role, READ[page])) throw new ForbiddenException('You do not have permission to do this.');
  }

  private toDto(v: SavedView, user: User, ownerName: string | null): SavedViewDto {
    return { id: v.id, page: v.page, name: v.name, query: v.query, shared: v.shared, mine: v.userId === user.id, ownerName, createdAt: v.createdAt.toISOString() };
  }
}
