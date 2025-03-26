import {Devvit} from '@devvit/public-api';

export type LoadingElementProps = Omit<Devvit.Blocks.IconProps, 'children'> & Devvit.Blocks.HasElementChildren;

// TODO
export const LoadingElement = (props: LoadingElementProps) => props.children ? <zstack>{props.children}</zstack> : <zstack alignment='center middle'> <icon {...props} children={''} /> </zstack>;
