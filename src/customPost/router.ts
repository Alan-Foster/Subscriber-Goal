/**
 * @file This is the router for the custom post pages.
 * It contains the definitions for the pages, as well as the logic to switch between them.
 * The pages are defined in the `Pages` constant, which maps the strings from the PageName type to their respective components. Similar logic is used for the page states.
 * The Router class stores the Devvit context, current page and allows changing between pages. It also holds persistent page states, allowing for data to be shared between pages (as opposed to being reset on every page change).
 */

import {Context, useState, UseStateResult} from '@devvit/public-api';

import {CompletedPage} from './pages/completed/completedPage.js';
import {SubGoalPage} from './pages/subGoal/subGoalPage.js';
import {SubGoalState} from './pages/subGoal/subGoalState.js';
import {ThanksPage} from './pages/thanks/thanksPage.js';

// String literals of all page names. When adding a new page, start by adding its name here.
export type PageName = 'subGoal' | 'thanks' | 'completed';

export class Router {
  readonly _currentPage: UseStateResult<PageName>;
  public PageStates: PageStateList;

  /**
   * @param context - Instance of Context, provided by Devvit.
   * @param startPage - The default page to display when the router is created.
   */
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

  /**
   * Changes the current page to the specified one.
   * @param page - The name of the page to switch to.
   */
  public changePage (page: PageName) {
    // You could potentially add side effects to page changes here (clean up, etc.)
    if (this.currentPage !== page) {
      this.currentPage = page;
    }
  }
}

// This defines each page as a component that takes an instance of the Router as a parameter.
// That allows each page to access the router's current page and the Devvit context.
export type PageElement = (router: Router) => JSX.Element;

// This type is used to ensure that each PageName corresponds to a valid PageElement.
export type PageList = {
  [key in PageName]: PageElement;
};

// This is step 2 of adding a new page, it maps each of the PageName strings to their respective page components.
export const Pages: PageList = {
  subGoal: SubGoalPage,
  thanks: ThanksPage,
  completed: CompletedPage,
};

export interface PageProps {
  router: Router;
}

/**
 * The main Page component that returns the current page based on the router's currentPage state.
 * @param props - The PageProps, which is just an object containing the router instance.
 * @param props.router - The Router instance that holds the current page and context.
 * @returns The associated page component from the Pages constant based on the current page name.
 */
export const Page = ({router}: PageProps) => Pages[router.currentPage](router);

// This is where we define the state objects for each page.
// It is also the third step in adding a new page. If you set it to undefined, it means that the page will not keep changes between page changes.
// The final step is to initialize the new page state in the Router constructor, which can be as simple as just setting it to `undefined` if no state is needed.
export const PageStateTypes = {
  subGoal: SubGoalState,
  thanks: undefined,
  completed: undefined,
};

// Some type magic to ensure that the PageStates in the Router class are strongly typed correctly based on the PageStateTypes.
// It also enforces that the PageStates are initialized in the Router constructor.
export type PageStateList = {
  [key in PageName]: typeof PageStateTypes[key] extends new (context: Context, router: Router) => unknown ? InstanceType<typeof PageStateTypes[key]> : undefined;
}
