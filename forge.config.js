const path = require('path');

module.exports = {
  packagerConfig: {
    asar: true, // 启用ASAR打包，将源代码打包成单个归档文件
    icon: path.join(__dirname, 'assets', 'icon'), // 不带扩展名，让Electron自动选择
    name: 'Paper Reading Assistant', // 应用显示名称
    executableName: 'paper-reading-assistant', // 可执行文件名称
    // 排除不需要打包的文件，减小体积
    ignore: [
      /\.git/,
      /node_modules\/\.cache/,
      /\.vscode/,
      /\.github/,
      /README\.md/,
      /\.gitignore/,
      /forge\.config\.js/
    ]
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'paper-reading-assistant',
        setupIcon: path.join(__dirname, 'assets', 'icon.ico'),
        authors: 'Anton Yang',
        description: 'Automatically read, translate, and extract key insights from research papers.',
        // 优化安装速度的配置
        noMsi: true,                    // 只生成exe，不生成msi，减少构建时间
        remoteReleases: false,          // 不检查远程版本，加快安装速度
        allowOfflineMode: true,         // 允许离线模式
        deltaCompressionLevel: 6        // 降低压缩级别，平衡文件大小和速度
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux']
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          icon: path.join(__dirname, 'assets', 'icon.png')
        }
      }
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          icon: path.join(__dirname, 'assets', 'icon.png')
        }
      }
    }
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'antonidasyang',
          name: 'pra'
        },
        prerelease: false,
        draft: true
      }
    }
  ]
}