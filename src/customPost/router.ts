import {Context, useState, UseStateResult} from '@devvit/public-api';

import {CompletedPage} from './pages/completed/completedPage.js';
import {SubGoalPage} from './pages/subGoal/subGoalPage.js';
import {SubGoalState} from './pages/subGoal/subGoalState.js';
import {ThanksPage} from './pages/thanks/thanksPage.js';

export type PageName = 'subGoal' | 'thanks' | 'completed'; // String literals of all page names

export class Router {
  readonly _currentPage: UseStateResult<PageName>;
  // eslint-disable-next-line no-use-before-define
  public PageStates: PageStateList;

  constructor (readonly context: Context, startPage: PageName) {
    this._currentPage = useState<PageName>(startPage);

    // We need to initialize the page states here, otherwise they'll get reset on every page change
    this.PageStates = {
      subGoal: new SubGoalState(context, this),
      thanks: undefined,
      completed: undefined,
    };
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
  router: Router;
}

export type PageElement = (router: Router) => JSX.Element;

export type PageList = {
  [key in PageName]: PageElement;
};

export const Pages: PageList = {
  subGoal: SubGoalPage,
  thanks: ThanksPage,
  completed: CompletedPage,
};

export const Page = ({router}: PageProps) => Pages[router.currentPage](router);

export const PageStateTypes = {
  subGoal: SubGoalState,
  thanks: undefined,
  completed: undefined,
};

export type PageStateList = {
  [key in PageName]: typeof PageStateTypes[key] extends new (context: Context, router: Router) => unknown ? InstanceType<typeof PageStateTypes[key]> : undefined;
}
