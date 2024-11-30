# CloudSync Plugin for Obsidian

CloudSync is an Obsidian plugin that leverages cloud object storage to maintain a synchronized copy of your vault in the cloud. By connecting to Azure Blob Storage, AWS S3, or Google Cloud Storage, the plugin enables three key capabilities: maintaining an always-current backup of your notes, seamlessly synchronizing your vault across multiple devices, and providing secure remote access to your notes when needed. Whether you're switching between devices, safeguarding your knowledge base, or accessing notes on the go, CloudSync handles the complexity of cloud synchronization while maintaining the security and integrity of your data.

**Important:** Implementation requires cloud provider account configuration and secure credential management. The complexity of setup varies by provider:

- Azure Storage offers the most straightforward setup through its web console
- AWS S3 requires intermediate configuration, including creation of a JSON access policy
- GCP Cloud Storage has the most complex setup, requiring execution of multiple commands in Google Cloud Shell

While the setup instructions are detailed and systematic, users without prior experience with cloud platforms should expect some learning curve, particularly for AWS and GCP implementations.

## 🚀 Features

- **Multi-Cloud Support**: Connect to leading three cloud providers:
  - Azure Blob Storage
  - AWS S3
  - Google Cloud Storage
- **Multi-Vault support**: Synchronizes multiple Obsidian vaults into a single storage bucket/account
- **Cross-Device Compatibility**: Synchronize Obsidian vaults between devices
- **Direct Cloud Connection**: No intermediate servers - data flows directly from Obsidian to cloud storage
- **Secure Transfer**: Uses transport encryption (TLS) and cloud provider's encryption at rest
- **Least privilege access**: Access credentials have lowest possible access rights to minimize the impact if credentials are compromised

## 📚 Documentation

- [Installation Guide](doc/install.md)
  - [Azure Setup](doc/azure.md)
  - [AWS Setup](doc/aws.md)
  - [GCP Setup](doc/gcp.md)
- [How it Works](doc/internals.md)
- [Security](doc/security.md)

## ❓ FAQ

**Q: Are my notes encrypted?**
A: The plugin uses transport encryption (TLS) and relies on cloud provider encryption at rest. Plugin is not encrypting files in local Obsidian Vault.

**Q: Where are my credentials stored?**
A: Credentials are stored locally in `data.json` in plugin directory of each Vault that has plugin installed.

**Q: Are my cloud credentials encrypted?**
A: Credentials in `data.json` are not encrypted, so user can find them and copy across different vaults.

**Q: What are the worst case scenarios?**
A: Leaked/exposed cloud credentials have no permissions beyond assigned storage account. The worst case scenarios:
- bad actor deletes all files from the storage account
- bad actor bloats the storage account with excessive data and causes financial damage
- bad actor uses leaked credentials to get access to synchronized files in storage account

**Q: Can the plugin developers access my data?**
A: No. The plugin connects directly to cloud storage. No data passes through third-party servers.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
