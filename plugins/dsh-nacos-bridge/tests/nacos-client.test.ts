import { describe, it, expect } from 'vitest'
import { mcpUrl, mcpHeaders } from '../src/nacos-client.ts'

const SERVER = {
  id: 'abc',
  name: 'demo-server',
  protocol: 'streamable',
  remoteServerConfig: {
    exportPath: '/mcp',
    frontEndpointConfigList: [
      {
        type: 'DIRECT',
        protocol: 'streamable',
        endpointData: { address: '127.0.0.1', port: 20021 },
        path: '/mcp',
      },
    ],
  },
}

describe('mcpUrl', () => {
  it('从 remoteServerConfig.frontEndpointConfigList 拼 URL', () => {
    expect(mcpUrl(SERVER)).toBe('http://127.0.0.1:20021/mcp')
  })

  it('无 endpoint 返回空串', () => {
    expect(mcpUrl({ id: 'x', name: 'x' })).toBe('')
  })

  it('path 无 / 前缀自动补', () => {
    const s = {
      ...SERVER,
      remoteServerConfig: {
        ...SERVER.remoteServerConfig,
        frontEndpointConfigList: [{ type: 'DIRECT', protocol: 'streamable', endpointData: { address: 'h', port: 80 }, path: 'mcp' }],
      },
    }
    expect(mcpUrl(s)).toBe('http://h:80/mcp')
  })
})

describe('mcpHeaders', () => {
  it('提取 headers', () => {
    const s = {
      ...SERVER,
      remoteServerConfig: {
        ...SERVER.remoteServerConfig,
        frontEndpointConfigList: [
          { type: 'DIRECT', protocol: 'streamable', endpointData: { address: 'h', port: 80 }, path: '/mcp', headers: [{ key: 'Authorization', value: 'Bearer x' }] },
        ],
      },
    }
    expect(mcpHeaders(s)).toEqual({ Authorization: 'Bearer x' })
  })

  it('无 headers 返回空对象', () => {
    expect(mcpHeaders(SERVER)).toEqual({})
  })
})
