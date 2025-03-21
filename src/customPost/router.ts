import {Context, useState, UseStateResult} from '@devvit/public-api';

import {SubGoalPage} from './pages/subGoal/subGoalPage.js';

export type PageName = 'subGoal'; // String literals of all page names

export class Router {
  readonly _currentPage: UseStateResult<PageName>;

  constructor (readonly context: Context, startPage: PageName) {
    this._currentPage = useState<PageName>(startPage);
    // This is where you could define things you want to persist across page changes.
    // Alternatively you could load the states for all pages here to avoid them being unloaded and reloaded on page changes.
  }

  get currentPage () {
    return this._currentPage[0];
  }
  protected set currentPage (page: PageName) {
    this._currentPage[1](page);
  }

  public changePage (page: PageName) {
    // You could potentially add side effects to page changes here (clean up, etc.)
    if (this.currentPage !== page) {
      this.currentPage = page;
    }
  }
}

export interface PageProps {
  context: Context;
  router: Router;
}

export type PageElement = (context: Context, router: Router) => JSX.Element;

export type PageList = {
  [key in PageName]: PageElement;
};

export const Pages: PageList = {
  subGoal: SubGoalPage,
};

export const Page = ({context, router}: PageProps) => Pages[router.currentPage](context, router);
