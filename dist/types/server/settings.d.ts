import type { AppSettings } from '../shared/types/api';
import type { SettingsClient } from './types';
export declare const defaultAppSettings: AppSettings;
export declare function getAppSettings(settings?: SettingsClient): Promise<AppSettings>;
