/**
 * @file Defines the LoadingElement component, which is used to show a loading icon when the actual children are still undefined.
 */
import {Devvit} from '@devvit/public-api';

export type LoadingElementProps = Omit<Devvit.Blocks.IconProps, 'children'> & Devvit.Blocks.HasElementChildren;

// TODO: Maybe get rid of this or allow more customization for the placeholder element (e.g. display a box with the expected size of the content instead of a single icon). I'm also not entirely if the props.children check is effective.
export const LoadingElement = (props: LoadingElementProps) => props.children ? <zstack>{props.children}</zstack> : <zstack alignment='center middle'> <icon {...props} children={''} /> </zstack>;
