import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const STATE = resolve(process.env.DREBOT_STATE || join(homedir(), 'tmp', 'cc'))
export const CONFIG = join(STATE, 'config')
