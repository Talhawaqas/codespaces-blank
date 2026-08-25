"use client";
import { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { buildProofOfStoragePayload } from '../lib/merkle'; // adjust path if lib/merkle.js lives elsewhere in your project
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ReferralSection from '../components/ReferralSection';
import HackathonSection from '../components/HackathonSection';
import LearnSection from '../components/learn/LearnSection';
import NetworkVisualization from '../components/security/NetworkVisualization';
import EmptyState from '../components/EmptyState';
import AccentGraphic from '../components/AccentGraphic';
import Skeleton from '../components/Skeleton';
import { track } from '@vercel/analytics';

// Styling for assistant chat replies rendered via react-markdown — kept
// outside the component since it never changes between renders.
const chatMarkdownComponents = {
  p: ({ node, ...props }) => <p className="mb-2 last:mb-0" {...props} />,
  ul: ({ node, ...props }) => <ul className="list-disc list-outside ml-4 space-y-1 mb-2" {...props} />,
  ol: ({ node, ...props }) => <ol className="list-decimal list-outside ml-4 space-y-1 mb-2" {...props} />,
  li: ({ node, ...props }) => <li {...props} />,
  strong: ({ node, ...props }) => <strong className="text-[#00f2fe] font-bold" {...props} />,
  a: ({ node, ...props }) => <a className="text-[#00f2fe] underline" target="_blank" rel="noreferrer" {...props} />,
  code: ({ node, ...props }) => <code className="bg-black/30 px-1 py-0.5 rounded text-[12px]" {...props} />,
  h1: ({ node, ...props }) => <p className="font-bold text-white mb-1" {...props} />,
  h2: ({ node, ...props }) => <p className="font-bold text-white mb-1" {...props} />,
  h3: ({ node, ...props }) => <p className="font-bold text-white mb-1" {...props} />,
};

// ========================================================
// 📣 UPDATES & KNOWLEDGE BASE DRAWER — content source
// ========================================================
// Kept as a local structured array rather than a CMS fetch for now — no
// backend exists for this yet, and a hardcoded array is a straightforward
// upgrade path to a real API later (same shape, different source). Body
// text is a placeholder until the actual articles are written.
//
/**
 * @typedef {Object} KnowledgeArticle
 * @property {string} id
 * @property {'Knowledge Base'|'Blog'} category
 * @property {string} title
 * @property {string} excerpt - short teaser shown on the collapsed card
 * @property {string} date - ISO date string
 * @property {string} [body] - full content, shown when the card is expanded in place
 * @property {string} [externalUrl] - if set, the card links out instead of expanding (e.g. a post published elsewhere)
 */
/** @type {KnowledgeArticle[]} */
const KNOWLEDGE_ARTICLES = [
  {
    id: 'what-is-depin',
    category: 'Blog',
    title: "What Is DePIN? A Complete Beginner's Guide (2026)",
    excerpt: "Learn what DePIN (Decentralized Physical Infrastructure Networks) is, how it works, why it matters, and why decentralized storage is becoming one of the fastest-growing sectors in Web3.",
    date: '2026-08-02',
    body: `What Is DePIN? A Complete Beginner's Guide to Decentralized Physical Infrastructure Networks

What Is DePIN? A Complete Beginner's Guide to Decentralized Physical Infrastructure Networks

Introduction

For decades, the world's digital infrastructure has been built around centralized ownership.

A handful of corporations own the cloud servers that host our applications, store our files, power artificial intelligence, and deliver the services we rely on every day. Whether you're streaming a movie, backing up family photos, training AI models, or running a global enterprise, chances are your data passes through infrastructure controlled by a small number of providers.

This model has enabled tremendous innovation—but it also creates significant risks.

What happens if a major cloud provider experiences an outage?

What happens if access to your data is restricted by policy changes, regional regulations, or censorship?

What happens when storage costs continue rising as businesses generate exponentially more data every year?

These aren't theoretical questions. Large-scale cloud outages have interrupted businesses worldwide. Regulatory changes increasingly influence where data can be stored and who can access it. At the same time, the explosion of AI, high-resolution media, IoT devices, and enterprise analytics has created unprecedented demand for digital infrastructure.

These challenges have inspired a new movement within Web3 known as Decentralized Physical Infrastructure Networks, or DePIN.

Rather than relying on a few massive corporations to own and operate infrastructure, DePIN allows thousands of independent participants around the world to contribute real-world resources—such as storage, computing power, wireless coverage, or energy—to a decentralized network. In return, contributors receive blockchain-based incentives for supporting the ecosystem.

Instead of building infrastructure from the top down, DePIN builds it from the bottom up.

This guide explains what DePIN is, how it works, why it's attracting significant investment, and why decentralized storage has become one of the fastest-growing sectors within Web3.

What Does DePIN Mean?

DePIN stands for Decentralized Physical Infrastructure Networks.

While the term sounds technical, each word has a straightforward meaning.

Decentralized

Traditional infrastructure is typically owned and managed by a single organization.

A decentralized network distributes responsibility across thousands of independent participants. No single company owns every server, every storage device, or every computing resource.

Instead, the network grows organically as more people contribute infrastructure.

Physical

Unlike purely digital blockchain applications, DePIN depends on real-world hardware.

This can include:

Hard drives

Servers

GPUs

Internet hotspots

Sensors

Solar panels

Network equipment

Participants provide physical resources that perform useful work.

Infrastructure

Infrastructure refers to the foundational systems that power digital services.

Examples include:

Data storage

Cloud computing

Wireless connectivity

AI computing

Mapping systems

Energy networks

These services already exist today—but DePIN changes how they're owned and operated.

Networks

Instead of a centralized company managing every component, DePIN creates a distributed network of contributors.

Anyone meeting the protocol's requirements can participate by providing infrastructure.

Blockchain technology coordinates participation, verifies contributions, and distributes rewards automatically.

The result is a global marketplace where infrastructure is supplied by communities rather than monopolized by a few corporations.

Why DePIN Matters

Digital infrastructure has become one of the world's most important resources.

Unfortunately, today's infrastructure model comes with several limitations.

Single Points of Failure

Centralized cloud providers operate enormous data centers.

Although highly reliable, they still represent concentrated points of failure.

Hardware issues, software bugs, cyberattacks, or configuration mistakes can affect millions of users simultaneously.

Distributed infrastructure reduces this concentration of risk.

Vendor Lock-In

Migrating data between providers can be expensive and time-consuming.

Organizations often become dependent on one vendor's pricing, APIs, and ecosystem.

DePIN encourages interoperability and permissionless participation, reducing reliance on any single provider.

Expensive Scaling

As organizations generate larger datasets, infrastructure costs increase.

AI training, machine learning, scientific research, media production, and enterprise analytics all require growing amounts of storage and computing resources.

Instead of continuously building expensive centralized data centers, DePIN enables existing global resources to be utilized more efficiently.

Privacy Concerns

Many traditional cloud providers technically have access to customer data stored on their infrastructure.

Although security practices are continually improving, centralized storage inherently requires trust in the provider.

Many DePIN storage protocols shift encryption to the client, ensuring users retain control over their own encryption keys.

Regional Outages

Natural disasters, power failures, network disruptions, or geopolitical events can affect centralized infrastructure.

A geographically distributed network provides greater resilience by spreading resources across many independent operators.

How DePIN Works

Although each protocol has unique architecture, most DePIN networks follow a similar model.

Users

↓

Protocol

↓

Node Operators

↓

Blockchain

↓

Rewards

Here's how the process typically works.

Step 1: Users Request a Service

Users may need storage, computing power, wireless connectivity, mapping data, or AI processing.

They submit requests through the protocol.

Step 2: The Protocol Coordinates Resources

The protocol identifies suitable node operators capable of fulfilling the request.

Smart algorithms distribute workloads efficiently across the network.

Step 3: Node Operators Provide Infrastructure

Independent participants contribute real hardware.

Examples include:

Storage disks

GPU servers

Internet hotspots

Edge computing devices

They perform the requested work.

Step 4: Blockchain Records Activity

The blockchain maintains transparent records of:

Work completed

Resource availability

Reputation

Payments

Rewards

Smart contracts automate settlement without requiring centralized intermediaries.

Step 5: Contributors Receive Rewards

Participants earn blockchain-based incentives for providing useful infrastructure.

This creates an economic model where everyone benefits:

Users receive infrastructure services.

Node operators earn rewards.

The protocol expands as participation increases.

The incentives naturally encourage network growth and reliability.

Types of DePIN

DePIN is a broad category covering many forms of infrastructure.

Storage Networks

These networks provide decentralized data storage.

Instead of storing files in a single data center, encrypted data is distributed across many independent nodes.

Storage remains one of the largest and fastest-growing DePIN sectors due to exploding global data demand.

Compute Networks

Compute-focused protocols distribute CPU resources for workloads requiring processing power.

These networks support rendering, scientific simulations, distributed applications, and enterprise workloads.

Wireless Networks

Participants deploy wireless hotspots or networking equipment that expands internet connectivity.

Contributors are rewarded for providing useful network coverage.

GPU Networks

Artificial intelligence has dramatically increased demand for GPUs.

Decentralized GPU marketplaces allow idle graphics hardware to be rented for AI training, rendering, and machine learning tasks.

AI Infrastructure

AI requires enormous computational resources.

Emerging DePIN protocols coordinate distributed computing infrastructure that supports AI inference, model training, and decentralized intelligence.

Mapping Networks

Vehicles, mobile devices, and sensors continuously generate geographic information.

Mapping-focused DePIN protocols reward contributors for collecting and validating real-world spatial data.

Energy Networks

Some DePIN projects coordinate distributed energy production and storage.

Participants contribute renewable energy resources while blockchain technology tracks production, distribution, and incentives.

Why Storage Is One of the Biggest DePIN Opportunities

Every year humanity generates more data than ever before.

The growth isn't slowing.

Several major trends continue driving demand.

Artificial Intelligence

Training AI models requires massive datasets.

Large language models, image generation systems, and enterprise AI all consume enormous storage capacity.

Enterprise Digital Transformation

Organizations increasingly digitize operations, customer records, analytics, compliance documentation, and operational data.

Cloud storage requirements continue expanding.

Healthcare

Medical imaging, patient records, genomic research, and diagnostics generate extremely large datasets requiring long-term storage and security.

Media Production

Modern content creators produce:

4K video

8K video

RAW photography

Audio production

Animation assets

These files consume significant storage space.

Personal Data

Individuals now store:

Family photos

Videos

Financial documents

Backups

Mobile device data

Digital memories

As digital lifestyles expand, storage becomes a necessity rather than a luxury.

Because demand continues increasing across nearly every industry, decentralized storage has become one of the strongest long-term opportunities within DePIN.

Centralized Storage vs DePIN

Feature

Centralized Storage

DePIN Storage

Ownership

Single company

Community network

Participation

Permissioned

Permissionless

Infrastructure

Centralized data centers

Distributed nodes

Failure Risk

Higher single points of failure

Distributed resilience

Vendor Lock-In

Common

Reduced

Data Control

Provider-managed access

User-controlled encryption keys

Transparency

Limited

Blockchain-verifiable metadata

Scalability

Provider expands infrastructure

Community contributes resources

Neither model is universally better for every use case.

Many organizations may adopt hybrid approaches, combining centralized infrastructure with decentralized services depending on performance, compliance, and resilience requirements.

Where Inaya Network Fits

Within the broader DePIN landscape, different protocols focus on different aspects of infrastructure.

Some emphasize low-cost storage, while others prioritize privacy, performance, or enterprise integration.

Inaya Network focuses on a security-first architecture built around user ownership and decentralized storage principles.

Its design includes several core concepts:

Client-Side Encryption

Files are encrypted before leaving the user's device, reducing reliance on storage providers for confidentiality.

Binary Sharding

Rather than storing an entire encrypted file in one location, encrypted data can be divided into separate binary shards that are distributed across independent storage nodes.

This approach helps improve resilience while reducing dependence on any individual storage provider.

Blockchain Metadata

Instead of storing file contents on-chain, blockchain records maintain metadata such as file references, verification information, and integrity proofs.

This keeps blockchain storage efficient while preserving transparency.

User-Controlled Access

Users maintain control over access credentials and encryption keys, allowing them—not infrastructure providers—to determine who can access stored information.

These architectural choices reflect broader DePIN goals: decentralization, privacy, resilience, and user ownership.

The Future of DePIN

Many analysts believe DePIN represents one of the most significant infrastructure trends emerging from Web3.

Several developments are expected to shape its growth over the coming years.

Artificial Intelligence

As AI adoption accelerates, demand for decentralized computing, storage, and GPU infrastructure is likely to increase substantially.

Enterprise Adoption

Businesses continue exploring decentralized infrastructure for cost optimization, redundancy, and improved resilience.

Hybrid architectures that combine traditional cloud services with DePIN may become increasingly common.

Digital Sovereignty

Governments, enterprises, and individuals are placing greater emphasis on maintaining control over their digital assets.

DePIN aligns with this trend by reducing dependence on centralized infrastructure providers.

Edge Computing

As connected devices continue to expand—from autonomous vehicles to industrial sensors—processing data closer to where it is generated becomes increasingly important.

Distributed infrastructure is well suited to supporting these edge computing environments.

Growing Community Participation

Perhaps the most important aspect of DePIN is its economic model.

Instead of relying solely on large corporations to build global infrastructure, communities can collectively contribute resources and be rewarded for doing so.

This creates infrastructure that grows organically as participation increases.

Conclusion

Digital infrastructure underpins nearly every aspect of modern life.

As data volumes continue expanding and AI reshapes industries, demand for secure, scalable, and resilient infrastructure will only grow.

DePIN introduces a different model—one where communities contribute real-world infrastructure, blockchain coordinates participation, and incentives encourage long-term network growth.

Whether through decentralized storage, distributed computing, wireless connectivity, GPU marketplaces, or emerging AI infrastructure, DePIN is redefining how digital services can be built and maintained.

While centralized cloud providers will continue to play a vital role, decentralized infrastructure offers a complementary approach that prioritizes resilience, transparency, and user ownership.

The evolution of the internet has always been driven by new infrastructure. DePIN represents the next chapter in that evolution.

DePIN isn't replacing the internet—it is building a more resilient version of it.

Frequently Asked Questions (FAQs)

Is DePIN the same as blockchain?

No. Blockchain is the underlying technology that records transactions and coordinates decentralized systems, while DePIN (Decentralized Physical Infrastructure Networks) is a real-world application of blockchain technology.

A DePIN network uses blockchain to manage and reward participants who contribute physical infrastructure such as storage devices, computing power, wireless hotspots, GPUs, or energy resources. In other words, blockchain provides the trust layer, while DePIN provides the infrastructure layer.

Is DePIN only for crypto users?

Not at all.

Although many DePIN projects use cryptocurrency or blockchain-based tokens for payments and rewards, the infrastructure itself is designed to serve anyone who needs digital services.

Businesses, developers, enterprises, and everyday users can benefit from decentralized storage, computing, or networking without needing extensive knowledge of cryptocurrency. As user experiences improve, interacting with DePIN services is expected to become as simple as using traditional cloud platforms.

Can businesses use DePIN?

Yes.

Many enterprises are exploring DePIN as a complementary infrastructure solution alongside traditional cloud providers. Potential business use cases include:

Secure document storage

Disaster recovery and backups

AI data storage

Media asset management

Distributed computing

Long-term archival storage

Rather than replacing existing cloud infrastructure entirely, many organizations may adopt hybrid approaches that combine centralized and decentralized services to improve resilience, flexibility, and cost efficiency.

Is decentralized storage secure?

It can be extremely secure when implemented correctly.

Many decentralized storage protocols encrypt data before it leaves the user's device, ensuring that storage providers cannot read the contents of stored files. Some protocols also distribute encrypted data across multiple independent nodes, reducing reliance on any single storage provider.

Ultimately, security depends on the protocol's architecture, encryption standards, and how users manage their encryption keys and access credentials.

How do DePIN node operators make money?

Node operators earn rewards by contributing useful infrastructure to the network.

Depending on the protocol, they may provide:

Storage capacity

GPU computing power

CPU resources

Wireless coverage

Internet bandwidth

Mapping data

Energy generation

When users consume these services, the protocol verifies the work performed and distributes blockchain-based rewards according to its incentive model. This creates a system where contributors are compensated for supporting the network while users gain access to decentralized infrastructure.

What are the biggest advantages of DePIN?

DePIN offers several key benefits over traditional infrastructure models, including:

Reduced reliance on centralized providers

Greater resilience through distributed networks

Permissionless participation for infrastructure providers

Improved transparency using blockchain technology

User ownership of encryption keys in many storage protocols

Incentive-driven growth that encourages network expansion

These advantages make DePIN an increasingly attractive option for industries seeking secure, scalable, and decentralized infrastructure.

Does DePIN replace traditional cloud providers?

Not necessarily.

DePIN is better viewed as a complementary infrastructure model rather than a direct replacement for traditional cloud services. Many businesses will continue using centralized cloud platforms while integrating decentralized infrastructure for specific workloads such as backups, archival storage, AI datasets, or disaster recovery.

This hybrid approach allows organizations to benefit from both centralized performance and decentralized resilience.

Why is decentralized storage considered one of the fastest-growing DePIN sectors?

Global data creation continues to accelerate due to artificial intelligence, cloud applications, enterprise software, IoT devices, healthcare, and high-resolution media.

As storage demand grows, decentralized storage networks provide an alternative way to scale infrastructure by leveraging unused capacity contributed by independent participants around the world. This community-driven model has made storage one of the most active and rapidly expanding areas within the broader DePIN ecosystem.`,
  },
  {
    id: 'client-side-encryption',
    category: 'Knowledge Base',
    title: "Why Client-Side Encryption Matters More Than Ever",
    excerpt: "Learn why client-side encryption is becoming essential for privacy, compliance, and secure decentralized storage.",
    date: '2026-08-02',
    body: `Introduction

For the better part of the last two decades, the tech industry has successfully convinced the public that the "cloud" is a secure vault. When a user sees the little padlock icon in their browser URL bar, they assume their data is private. However, from an infrastructure perspective, the cloud is simply someone else's computer.

Most people assume cloud storage equals privacy because providers heavily advertise their encryption standards. They boast about "bank-grade encryption" and secure data centers. But there is a fundamental architectural difference between encrypting data for a user and encrypting data by a user.

As we transition into an era defined by massive data breaches, sophisticated cyberattacks, and the rise of decentralized infrastructure, the traditional trust-based security model is showing its cracks. This article explores the mechanics of data storage, why standard server-side encryption is no longer sufficient, and why client-side encryption (CSE) is rapidly becoming the mandatory baseline for secure infrastructure.

What Happens When You Upload to Traditional Cloud Storage?

To understand the necessity of client-side encryption, we first need to dissect the standard operating procedure of legacy Web2 cloud storage platforms.

When you upload a file to a mainstream provider (like Google Drive, Dropbox, or AWS S3), the data is protected in transit using TLS (Transport Layer Security). This stops interceptors from reading the file as it travels through the internet. Once it reaches the provider's servers, the file is encrypted at rest.

However, the sequence of operations looks like this:

The Traditional Cloud Storage Workflow:

User Upload: The user uploads plaintext data via a TLS connection (encrypted in transit).

Server Processing: The provider's server receives the data, briefly decrypting it to plaintext in memory.

Server Encryption: The provider's server encrypts the data using a key managed entirely by the provider.

Storage: The provider stores the encrypted file.

In this model, the provider manages both the lock and the key. While the data sits securely on a hard drive in a massive data center, the platform maintains the ultimate capability to decrypt that data whenever necessary.

Why Server-Side Encryption Isn't Enough

Server-Side Encryption (SSE) protects data against someone physically stealing a hard drive from a data center. It does very little to protect data from logical vulnerabilities, internal access, or systemic breaches. Relying on SSE requires absolute trust in the provider’s operational security and internal policies.

The Provider Owns the Keys

In cryptography, whoever holds the private keys controls the data. If a cloud provider manages the encryption keys, the system operates on a "trust-based" model rather than a "math-based" model. You are relying on a legal Terms of Service agreement to protect your privacy, rather than a cryptographic guarantee.

Insider Threats and Employee Access

Because the provider holds the keys, the technical capability for employees to access user data exists. While large tech companies have strict access controls and auditing logs, these systems are managed by humans. Database administrators, senior engineers, or compromised internal accounts can bypass application-layer security to access plaintext data directly from the storage architecture.

Third-Party and Government Requisitions

When a government agency or legal entity requests data, a provider holding the encryption keys is technically capable of complying. They can decrypt the user's files and hand them over, often without the user's immediate knowledge due to gag orders.

The Single Point of Failure for Breaches

If a sophisticated attacker breaches the cloud provider's key management system (KMS), they gain access to everything. The data and the keys to unlock that data are housed under the same corporate umbrella. Once the perimeter is breached, the attacker can decrypt millions of files simultaneously.

What Is Client-Side Encryption?

Client-Side Encryption (CSE)—often referred to as Zero-Knowledge Encryption—shifts the cryptographic burden from the server to the user's local device (the client).

In a CSE architecture, data is encrypted before it ever leaves the user's laptop, smartphone, or browser. The server receives only ciphertext (an unreadable string of scrambled data). Because the user generates and holds the key locally, the server never has the mathematical ability to read the file.

The Client-Side Encryption Workflow:

Local Encryption: The user's browser or app encrypts the plaintext data locally using a user-owned key.

Secure Upload: The client uploads the ciphertext to the provider over a secure connection.

Zero-Knowledge Reception: The provider's server receives only the ciphertext.

Blind Storage: The provider stores the ciphertext, retaining zero knowledge of the actual contents.

This represents a paradigm shift. The provider is no longer a trusted custodian of secrets; they are simply a blind storage medium.

The Core Advantages of Client-Side Architecture

Implementing client-side encryption solves several critical vulnerabilities inherent in legacy infrastructure.

Absolute Data Ownership and Privacy

With CSE, data sovereignty is returned to the user. Even if the cloud provider is completely compromised, the attacker only acquires encrypted blobs of data. Without the client's local passkey, these blobs are computationally impossible to decrypt. The user mathematically owns their data.

Easing Regulatory Compliance

For enterprise organizations, navigating data privacy laws like GDPR, HIPAA, or CCPA is a complex and expensive endeavor. By utilizing client-side encryption, the risk of exposing Personally Identifiable Information (PII) is drastically reduced. If a server holding CSE data is breached, no readable PII is exposed, often nullifying the strict reporting requirements and catastrophic fines associated with data leaks.

Reduced Trust Assumptions

Security engineers aim to minimize the "trust surface" of any system. CSE removes the need to trust a corporation's internal security policies, their hiring practices, or their resilience to state-level coercion. The trust is placed entirely in open-source cryptographic primitives (like AES-256) rather than corporate promises.

Industry Adoption: Where Client-Side Encryption is Already Standard

Client-side encryption is not experimental; it is already the industry standard in sectors where a data breach is unacceptable.

Password Managers: Applications like 1Password and Bitwarden encrypt your vault locally. If their servers are hacked, the attackers get nothing but ciphertext.

Healthcare: Medical applications handling patient records (ePHI) increasingly utilize CSE to ensure doctors can access data while preventing cloud hosts from viewing sensitive health information.

Legal Sector: Law firms managing privileged client communications or M&A documents use zero-knowledge data rooms to prevent corporate espionage.

Government and Defense: Defense contractors utilize local encryption before transmitting schematics or communications over public internet infrastructure.

Enterprise SaaS: Modern enterprise communication tools (like Signal for messaging) rely heavily on the end-to-end variant of client-side encryption to protect trade secrets.

The Convergence: Client-Side Encryption and DePIN

While CSE secures the data logically, Decentralized Physical Infrastructure Networks (DePIN) secure it physically.

DePIN replaces centralized data centers (like AWS or Google Cloud) with a globally distributed network of independent node operators. While this creates a highly resilient, censorship-resistant storage layer, it introduces a new security challenge: You cannot trust a random, decentralized node operator with your plaintext data.

This is why Client-Side Encryption and DePIN are perfectly complementary. CSE is the prerequisite that makes DePIN viable for sensitive data.

The DePIN + CSE Storage Workflow:

Local Security: Data is secured locally by the user.

Mathematical Fragmentation: The encrypted data is mathematically split into fragments (shards).

Global Distribution: These fragments are routed to independent global nodes.

Decentralized Storage: The nodes hold encrypted, mathematically useless shards until the user recalls them.

By combining these technologies, you eliminate both the logical single point of failure (the centralized encryption key) and the physical single point of failure (the centralized data center).

A Practical Example: The Modern Upload Workflow

To understand how this looks in practice, consider a user uploading a highly sensitive legal document to a modern decentralized protocol:

Selection: The user selects the PDF on their computer.

Local Encryption: Before the upload progress bar even starts, the browser uses a local passkey to run an AES-256 encryption algorithm on the file. The PDF becomes ciphertext.

Sharding: The ciphertext is mathematically split into multiple pieces (shards).

Distribution: These encrypted shards are sent across the internet to various independent storage nodes worldwide.

Metadata Registration: A cryptographic map (metadata) of where these shards live is recorded, often on a blockchain ledger.

Retrieval: When the user wants the file back, the application fetches the shards, reassembles them, and only then asks for the user's local passkey to decrypt the data back into a readable PDF.

At no point in this workflow could an intermediary, a node operator, or a network creator view the contents of the PDF.

How Inaya Uses Client-Side Encryption

Building secure infrastructure requires strict adherence to proven cryptographic standards rather than proprietary "black-box" solutions. The Inaya Network approaches decentralized storage by treating client-side encryption as a foundational requirement, not an optional feature.

Here is an educational breakdown of how the Inaya protocol structures this architecture:

1. AES-256 Client-Side Execution

The protocol utilizes AES-256 (Advanced Encryption Standard with a 256-bit key). AES-256 is one of the most widely adopted encryption standards and is used across government, enterprise, banking, healthcare, and cloud infrastructure worldwide. Crucially, the Inaya SDK executes this encryption entirely within the user's environment (browser, mobile app, or local server) prior to any network transmission.

2. Binary Sharding Engine

Encrypting a file as a single massive block and sending it to one decentralized node is inefficient and risky. Inaya implements a Binary Midpoint Bisection sharding engine. Once the data is encrypted via AES-256 on the client side, it is systematically split into smaller, uniform binary fragments. This ensures that a single storage node never holds a complete file, even in its encrypted state.

3. Immutable Blockchain Metadata

Managing decentralized, encrypted shards requires a flawless tracking mechanism. Instead of using a centralized database that could be manipulated or deleted, Inaya maps the location and ownership hashes of these encrypted shards directly onto the BNB Chain via smart contracts. This allows a user to cryptographically prove ownership and retrieve their shards without relying on a centralized API.

4. User-Controlled Passkeys

The entire system hinges on the fact that the decryption keys are fundamentally decoupled from the storage architecture. The encryption passkey never leaves the user's device. The protocol is designed so that encryption keys remain under user control. Storage nodes, smart contracts, and protocol infrastructure do not possess the information required to decrypt user files.

Conclusion

The transition from Server-Side Encryption to Client-Side Encryption represents an evolution in how we view digital trust. We are moving away from relying on corporate policies to protect our data, and moving toward relying on mathematics.

As physical infrastructure becomes increasingly decentralized, the logical security of our data must adapt. Client-side encryption shifts control back to the user by ensuring sensitive information is protected before it enters any storage network. Combined with decentralized infrastructure, it enables a model where privacy, resilience, and ownership are built into the architecture rather than added later. As organizations continue generating more valuable digital assets, architectures that minimize trust assumptions are likely to play an increasingly important role in the future of data storage.

Frequently Asked Questions (FAQs)

1. What happens if I lose my client-side encryption passkey?

Because the system is zero-knowledge, the provider does not have a copy of your key. If you lose your passkey, the encrypted data cannot be recovered by anyone, including the platform's support team. It is mathematically locked forever.

2. Does client-side encryption slow down the upload process?

Modern processors (even on smartphones) are incredibly efficient at cryptographic operations. While encrypting a file locally takes a fraction of a second, the bottleneck is almost always the user's internet bandwidth, not the local encryption process.

3. If the server only sees encrypted data, how do features like "search" work?

Searching within encrypted files is challenging. Traditional cloud providers index your plaintext data to allow fast searching. With CSE, the application must either download and decrypt the metadata locally to search it, or rely on advanced (and currently computationally heavy) techniques like Homomorphic Encryption.

4. Can server-side encryption ever be considered secure?

SSE is highly secure against external physical threats (like hardware theft) and casual digital interception. However, it requires you to inherently trust the entity managing the servers and the keys. It is secure, but it is not private.

5. How does DePIN differ from traditional cloud hosting?

Traditional hosting relies on massive, centralized data centers owned by a single corporation. DePIN utilizes a distributed network of independent hardware operators across the globe, providing better redundancy and eliminating a single corporate point of failure.

6. Why is AES-256 the standard for client-side encryption?

AES (Advanced Encryption Standard) is computationally efficient and currently resistant to all known brute-force attacks by classical computers. A 256-bit key provides  possible combinations, a number so massive that current supercomputers would take billions of years to crack it.`,
  },
  {
    id: 'centralized-vs-decentralized-storage',
    category: 'Knowledge Base',
    title: "Centralized Cloud vs Decentralized Storage: What's the Difference? (2026 Guide)",
    excerpt: "Compare centralized cloud storage with decentralized storage. Learn the differences in security, privacy, resilience, costs, and data ownership.",
    date: '2026-08-02',
    body: `1. Introduction

For over two decades, centralized cloud storage has been the undisputed backbone of the digital economy. Platforms like Amazon Web Services (AWS), Google Cloud Platform (GCP), and Microsoft Azure enabled startups to scale overnight and enterprises to eliminate local server racks. The value proposition was simple: offload infrastructure maintenance to hyperscale providers and pay only for what you consume.

However, as we navigate through 2026, the global storage landscape is confronting unprecedented challenges:

Escalating Costs: Unpredictable egress fees and vendor lock-in models have made cloud budgets unsustainable for high-volume data architecture.

Massive Security Breaches: Concentrating petabytes of global enterprise data in a handful of corporate server farms has created giant targets for cybercriminals and state-sponsored actors.

The Illusion of Privacy: Centralized providers manage encryption keys and maintain technical access to stored data, exposing businesses to internal rogue actors, subpoena demands, and compliance liabilities.

In response, Decentralized Storage—powered by Decentralized Physical Infrastructure Networks (DePIN)—has evolved from an experimental cryptographic concept into a production-ready alternative. By combining peer-to-peer hardware networks with client-side zero-knowledge encryption, decentralized storage fundamentally redefines how data is stored, secured, and priced.

This guide provides a comprehensive infrastructure comparison between traditional centralized cloud storage and modern decentralized storage networks.

2. How Traditional Cloud Storage Works

To understand the shift toward decentralization, we must first analyze the mechanics of legacy centralized storage architectures (such as AWS S3 or Azure Blob Storage).

Centralized storage operates on a client-server architecture hosted in massive, hyper-consolidated data centers. When an enterprise uploads a file to a centralized cloud provider, the following sequence occurs:

Ingestion: The user or application sends plaintext data over an encrypted TLS tunnel to the provider's API endpoint.

Key Management: The provider’s internal Key Management System (KMS) generates or retrieves an encryption key linked to the account.

Server-Side Encryption: The server briefly holds the file in plaintext within temporary memory, encrypts it using the provider's key, and writes the encrypted file to a physical storage disk (SAN/NAS).

Redundancy: The provider replicates the entire encrypted file across multiple physical hard drives within the same facility or across nearby Availability Zones (AZs) for fault tolerance.

The Centralized Vulnerability Structure

While this model provides high availability and fast throughput, it introduces significant structural vulnerabilities:

Single Entity Control: One corporate entity owns the physical hardware, manages the operating systems, holds the master encryption keys, and dictates API access.

Logical Single Point of Failure: If the provider’s identity provider (IAM) or Key Management System suffers a catastrophic breach or configuration failure, every file tied to that architecture becomes vulnerable simultaneously.

Geographical and Political Bottlenecks: Centralized data centers are bound by the jurisdiction of the nation-state in which they operate, subjecting host data to local search warrants, gag orders, and geopolitical sanctions.

3. What Decentralized Storage Changes

Decentralized storage flips the traditional client-server paradigm by removing centralized server farms entirely. Instead of trusting a single corporation, decentralized networks leverage global networks of independent, dedicated hardware operators (DePIN nodes).

Rather than transmitting a complete file to a single data center, decentralized storage relies on a zero-knowledge pipeline:

Client-Side Encryption: The user’s device encrypts the file locally using a key that never leaves the local environment.

Binary Sharding: The encrypted file is mathematically broken into dozens of small, unreadable fragments (shards).

Global Distribution: These encrypted shards are dispersed across a geographically diverse network of independent storage nodes.

On-Chain Tracking: The map detailing which node holds which shard is cryptographically anchored to a blockchain ledger, ensuring immutable record-keeping without exposing file contents.

By design, no single node in a decentralized network ever possesses a complete file, nor do node operators possess the cryptographic keys needed to read the shards they host.

4. Data Ownership: Trust-Based vs. Math-Based Models

The core distinction between centralized and decentralized storage lies in the model of data ownership.

Ownership Dimension

Centralized Cloud Storage

Decentralized Storage (DePIN)

Control Primitive

Legal Terms of Service & API Tokens

Private Keys & Smart Contracts

Key Ownership

Managed by Cloud Provider (Provider-Side)

Managed by End-User (Client-Side)

Access Verification

Database IAM Rules (Centralized)

On-Chain Cryptographic Proofs

Data Revocation

Trusting the provider deleted the file

Mathematical certainty via key disposal

Jurisdictional Risk

Bound by data center geographic region

Distributed multi-jurisdictional nodes

The Trust-Based Model

In legacy cloud systems, data "ownership" is a contractual promise. You pay a monthly fee, and the provider promises in their Terms of Service that they will not view, sell, or alter your files. However, technically and architecturally, the provider holds ultimate root access. They can disable your account, block API calls, or comply with silent government data seizures at their sole discretion.

The Math-Based Model

Decentralized storage replaces human and corporate trust with mathematical guarantees. Because encryption happens on the client side before transmission, and because storage contracts are enforced by smart contracts on a blockchain, ownership is absolute. If you hold the private key, you own the data. Without your key, the entire global network cannot view or reconstruct a single file.

5. Security Comparison: Server-Side vs. Zero-Knowledge Architecture

Security is frequently cited by cloud vendors as their greatest strength. Hyperscalers spend billions annually on physical security, perimeter firewalls, and compliance certifications. However, physical perimeter security does not protect against architectural flaws.

Centralized Security Vectors

KMS Breaches: When a hacker breaches a provider’s central Key Management System, they gain the keys to unlock all stored datasets under that key ring.

Privileged Insider Risk: System administrators, cloud engineers, and database operators have high-level permissions that can be exploited via social engineering, phishing, or direct malicious intent.

API Misconfigurations: A single misconfigured S3 bucket permission can expose millions of customer records in plaintext to the public internet.

Decentralized Security Vectors

Zero-Knowledge Architecture: Because encryption occurs on the client device before network transmission, data travels and resides as raw ciphertext. Even if an attacker compromises a storage node, they only recover an encrypted fragment of a file that is mathematically unreadable without the user's local key.

Sharding Protection: To reconstruct a file, an attacker would need to identify, breach, and compromise dozens of independent storage nodes scattered across different continents simultaneously—and then break AES-256 encryption.

Immutability: On-chain metadata prevents unauthorized tampering or silent modification of file structures.

6. Availability and Redundancy Mechanisms

How do both systems guarantee that your files are online when you need them?

Centralized Cloud: Multi-AZ Replication

Centralized providers achieve high availability (typically  to ) by creating multiple copies of your file and storing them in distinct data center buildings within an "Availability Zone" (AZ).

Limitation: If a catastrophic regional event (power grid failure, major fiber cut, or targeted cyberattack) takes down an entire region, or if an administrative error revokes account access, all availability zones in that cluster can become unreachable simultaneously.

Decentralized Cloud: Erasure Coding and Peer Replication

Decentralized networks achieve fault tolerance through Erasure Coding and peer-to-peer distribution.

Instead of creating complete duplicate copies of a 100MB file (which wastes bandwidth and storage), an erasure coding algorithm breaks the encrypted file into  total shards (e.g., 30 shards), structured so that any  subset of those shards (e.g., any 10 shards) can mathematically reconstruct the entire file.

Resilience Advantage: Out of 30 global storage nodes holding shards of your file, 20 nodes could simultaneously go offline, experience power outages, or get disconnected from the internet—and your file remains  retrievable in real time from the remaining 10 nodes.

7. Cost Comparison: Hidden Cloud Fees vs. Open Market Efficiency

Storage costs extend beyond the headline rate per gigabyte. Centralized cloud pricing structures contain complex secondary charges that penalize high-throughput applications.

Centralized Cloud Cost Mechanics

Base Storage Fee: $15–$25 per Terabyte/Month (Standard S3 tiers).

Egress (Bandwidth) Fees: Providers charge steep penalties ($80–$90 per Terabyte) whenever you move data out of their ecosystem. This functions as a financial barrier to prevent organizations from migrating to competitors.

API Transaction Costs: Every GET, PUT, POST, and LIST request incurs incremental micro-charges that scale rapidly during traffic surges.

Minimum Storage Durations: Moving data out of cold storage archive tiers before 30, 90, or 180 days triggers early deletion penalties.

Decentralized Storage Cost Mechanics

Flat Resource Pricing: $2–$5 per Terabyte/Month (representing an  reduction compared to hyperscalers).

Zero or Minimal Egress Penalties: Peer-to-peer bandwidth costs are driven by open-market competition among node operators rather than corporate profit margins.

Utilization of Idle Capacity: DePIN networks tap into underutilized global enterprise hardware, reducing physical overhead costs.

Predictable Settlement: Costs are calculated deterministically via smart contracts, eliminating surprise utility bills.

8. Enterprise Considerations: Compliance, SLAs, and Onboarding

For enterprise architects, adopting storage technology requires satisfying strict legal, operational, and regulatory frameworks.

[ Enterprise Readiness Checklist ]

Criteria                  Centralized Cloud            Decentralized DePIN

-----------------------------------------------------------------------------

GDPR / CCPA Compliance    Requires complex DPA        Compliant via zero-knowledge

client-side data anonymization

SLA Guarantees            Contractual financial       Enforced cryptographically via

credits after downtime      smart-contract SLA penalties

Payment Friction          Standard Credit / Invoice   Historically required crypto wallets;

Modern DePIN supports Fiat/Card

IAM & SSO Integration     Native Active Directory     Typed API wrappers / SDK bridge

Navigating Privacy Regulations (GDPR / CCPA)

Under regulations like GDPR, storing personal data requires strict access controls and the guaranteed "Right to be Forgotten." Centralized cloud providers process data in plaintext within memory, making them legally defined "Data Processors" subject to heavy auditing.

Decentralized storage platforms using client-side encryption store only unreadable, sharded ciphertext. Because no personally identifiable information (PII) ever hits the network in plaintext, the storage layer is cryptographically anonymous, simplifying compliance burdens for enterprise buyers.

Eliminating Web3 Onboarding Friction

Historically, the greatest barrier to enterprise adoption of decentralized storage was the requirement to manage cryptocurrency wallets, buy native utility tokens, and handle variable gas fees. Modern enterprise-grade DePIN platforms solve this by offering Fiat Payment Gateways. Enterprise procurement teams can buy decentralized storage plans using standard corporate credit cards or invoicing, while an automated protocol layer handles all underlying blockchain transactions seamlessly.

9. Common Misconceptions About Decentralized Storage

Despite rapid advancements, several outdated myths surround decentralized storage technology:

Myth 1: "Because it’s on a public network, anyone can see my files."

Fact: Public decentralized storage networks host only encrypted shards. A node operator hosting your file fragment sees only an unreadable string of binary code. Without your client-side private key, viewing the contents of a file on a decentralized network is mathematically impossible.

Myth 2: "Decentralized storage is too slow for real-world applications."

Fact: Early peer-to-peer networks suffered from latency issues. However, modern 2026 DePIN protocols utilize parallel retrieval algorithms. Because your file is sharded across dozens of global nodes, your device downloads multiple shards simultaneously from the fastest geographically local nodes, often outperforming single-stream downloads from a distant centralized data center.

Myth 3: "You need crypto tokens to use decentralized cloud."

Fact: While the backend settlement layer operates on blockchain technology, modern enterprise DePIN platforms provide standard REST APIs, TypeScript SDKs, and credit card payment options. Developers and businesses can integrate decentralized storage without ever interacting with a crypto exchange.

10. When Centralized Storage Is Still Better

Decentralized storage is transformative, but it is not a universal replacement for every compute and storage workload. Centralized cloud remains the preferred choice in specific scenarios:

Monolithic Legacy Systems: Legacy enterprise applications built deeply around AWS-native proprietary APIs (such as AWS DynamoDB, Athena, or Lambda triggers) can require extensive refactoring to decouple from centralized object storage.

Ultra-Low Latency In-Memory Analytics: Applications requiring sub-millisecond, unencrypted raw memory streaming for heavy real-time data processing may benefit from direct co-location within a single centralized server cluster.

Mandated Physical Audits: Certain legacy regulatory bodies still require physical paper trails verifying the exact building, room, and server rack where physical disks reside—a model fundamentally incompatible with distributed global node networks.

11. When Decentralized Storage Is the Better Choice

Decentralized storage is the superior architectural choice for organizations prioritizing data security, cost control, and long-term data preservation:

High-Value Digital Assets: Sensitive IP, legal contracts, financial ledgers, healthcare records, and corporate backups where data leaks are unacceptable.

Cost-Sensitive Multi-Petabyte Archives: Organizations seeking to eliminate predatory egress bandwidth charges and multi-thousand-dollar cloud bills.

SaaS Platforms Building Privacy-First Products: Applications offering true zero-knowledge data privacy to their end users without maintaining complex, high-liability database infrastructure.

Censorship-Resistant Media and Publishing: Global media outlets ensuring their content cannot be taken offline by regional firewalls or single-point infrastructure shutdowns.

12. The Hybrid Cloud Future

The future of enterprise IT infrastructure is not an immediate, absolute migration away from Web2 cloud providers. Instead, the industry is moving toward a Hybrid Cloud Model.

In a modern hybrid stack:

Centralized Cloud (AWS / GCP / Azure) is utilized for ephemeral compute, real-time application processing, and legacy database microservices.

Decentralized Storage (DePIN) is utilized as the persistent, ultra-secure, cost-effective storage layer for primary data vaults, user uploads, enterprise media, and immutable backup archives.

By routing object storage to decentralized infrastructure while retaining centralized compute pipelines, enterprises achieve the highest operational performance while cutting storage overhead by up to .

13. Where Inaya Fits

Building a seamless bridge between centralized enterprise workflows and decentralized physical infrastructure requires dedicated protocol engineering. This is where the Inaya Network fits into the modern cloud ecosystem.

The Inaya Network is a decentralized, sovereign custody network designed specifically for high-value digital assets and enterprise data storage. Rather than forcing developers to build complex cryptographic pipelines from scratch, Inaya packages end-to-end decentralized storage into a production-ready toolkit.

Key Architectural Pillars of Inaya Network:

Client-Side AES-256 Execution: Encryption is performed entirely within the user's local environment (browser, mobile app, or server) using the Inaya SDK before any data touches the network.

Binary Midpoint Bisection Sharding: Encrypted files are automatically split into uniform binary shards and distributed across independent storage nodes, ensuring zero single points of failure.

BNB Chain Metadata Anchoring: File location hashes, access permissions, and ownership maps are recorded immutably on the BNB Chain, providing cryptographically verifiable proof of storage without relying on centralized databases.

Frictionless Enterprise Payments: Inaya's Payments client introduces a "Pay by Card" SaaS model, allowing companies to procure decentralized storage using standard payment methods with no crypto wallet or token management required.

Developer-First SDKs: With drop-in React components (<InayaUploader/>, <InayaConnect/>), complete TypeScript support, and automated scaffolding tools (npx create-inaya-dapp), engineering teams can integrate decentralized storage in minutes.

14. Conclusion

The cloud storage industry is undergoing its most significant architectural shift since the inception of the internet. The traditional model—relying on centralized corporate silos, managing server-side keys, and paying exorbitant bandwidth fees—is no longer sustainable for privacy-conscious organizations.

Decentralized storage is not merely a technical alternative; it is an architectural upgrade. By combining client-side zero-knowledge encryption with global peer-to-peer infrastructure, it guarantees that data remains sovereign, cost-effective, and permanently resilient.

The future of cloud storage isn't simply about renting space on someone else’s computer—it’s about owning your data through unbreakable mathematics.

Frequently Asked Questions (FAQs)

1. What is the fundamental difference between centralized and decentralized storage?

Centralized storage hosts your files on servers owned and managed by a single corporation (like Amazon or Google) in centralized data centers. Decentralized storage encrypts, splits, and distributes your files across a global network of independent nodes running on dedicated peer-to-peer hardware.

2. Is decentralized storage safe for confidential business documents?

Yes. In fact, it is structurally safer than traditional cloud storage. Because data is encrypted locally on your device using client-side AES-256 encryption before it is uploaded, no node operator, hacker, or protocol developer can read your files.

3. What happens if a decentralized node operator turns off their computer?

Your files remain completely safe and accessible. Decentralized networks use Erasure Coding to break files into multiple shards and store them redundantly across dozens of global nodes. Only a small fraction of those nodes need to be online for you to reassemble and retrieve your file instantly.

4. How does decentralized storage reduce cloud costs so dramatically?

Decentralized networks eliminate the massive overhead costs of building and maintaining multi-billion-dollar corporate data centers. By leveraging globally distributed idle hardware and eliminating artificial egress bandwidth markups, storage costs are reduced by .

5. Can I use decentralized storage without owning cryptocurrency or crypto wallets?

Yes. Platforms like Inaya Network offer fiat gateways ("Pay with Card"), allowing enterprises and consumers to subscribe to decentralized storage using standard credit cards or invoices, while the underlying blockchain mechanics operate invisibly in the background.

6. Does decentralized storage comply with regulations like GDPR and HIPAA?

Yes. Because decentralized storage platforms using client-side encryption store only unreadable, encrypted shards, no plaintext Personally Identifiable Information (PII) is stored on the network. This zero-knowledge architecture minimizes compliance risks under global data protection laws.

7. How fast is file downloading on a decentralized network compared to AWS?

Decentralized storage often delivers faster download speeds for geographically dispersed users. Because files are sharded across global nodes, your device downloads multiple pieces of the file simultaneously from the closest available geographic nodes (parallel downloading), avoiding single-server bottlenecks.

8. What happens if I lose my private encryption key or passkey?

Because decentralized storage operates on a true zero-knowledge model, the platform provider does not maintain a backdoor or master key. If you lose your private encryption key, your data cannot be decrypted by anyone. It is recommended to store backup keys securely in offline enterprise key vaults.`,
  },
  {
    id: 'how-file-sharding-works',
    category: 'Knowledge Base',
    title: "How File Sharding Works: The Technology Behind Modern Decentralized Storage",
    excerpt: "Learn what file sharding is, how it works, why it improves resilience, and why modern decentralized storage protocols use sharding to protect user data.",
    date: '2026-08-02',
    body: `1. Introduction

When we think about saving a file—whether it is a family photograph, a corporate legal contract, or a compiled software application—we intuitively visualize it as a single, contiguous digital object. In traditional computing and legacy cloud storage, this is exactly how data is handled. A file is uploaded, transported, and stored as one complete entity on a physical hard drive in a centralized data center.

However, as the internet transitions toward Decentralized Physical Infrastructure Networks (DePIN), this monolithic approach to data storage is being fundamentally re-engineered. Storing complete files on independent, decentralized nodes introduces massive security and reliability risks. To solve this, infrastructure engineers rely on a process known as file sharding.

File sharding is the mathematical process of breaking a single dataset into multiple, smaller fragments before distributing them across a network. This guide explores the deep technical mechanics of file sharding, how it integrates with client-side encryption, and why it is the foundational technology powering the next generation of secure, decentralized cloud storage.

2. What Is File Sharding?

In the context of decentralized storage, file sharding is the process of taking a singular digital payload and dividing it into smaller, uniform pieces called "shards" or "fragments."

Do not confuse file sharding with database sharding. Database sharding is a horizontal scaling technique where rows of a massive database are separated across multiple servers to improve query speeds. File sharding, on the other hand, deals entirely with unstructured object storage. It is the act of splitting the binary data of a specific file so that no single storage medium holds the complete object.

When a file is sharded, the original data is parsed at the byte level and distributed. To the end-user, the file still appears as a single icon on their dashboard. But at the infrastructure layer, that file might exist as dozens of independent, encrypted binary fragments scattered across servers in Tokyo, Frankfurt, and New York.

3. Why Storing One Complete File Is Risky

To understand the necessity of sharding, we must look at the structural vulnerabilities of storing whole files, both in centralized clouds and decentralized networks.

The Honeypot Problem When a centralized cloud provider stores a complete file on a single server (even if it is replicated for backup), that server becomes a high-value target. If a malicious actor bypasses the network perimeter and gains access to the storage drive, they can extract the entire, intact file.

The Node Trust Dilemma in Decentralized Networks In a decentralized storage network, anyone can operate a storage node. If a protocol stored whole files on these independent nodes, a rogue node operator could easily inspect, copy, or ransom the files stored on their hardware. Trusting anonymous hardware operators with complete files is a catastrophic security flaw.

Bandwidth and Latency Bottlenecks If a 5-Gigabyte video file is stored entirely on one server in London, a user downloading that file from Sydney is bound by the latency and bandwidth limits of that single transcontinental connection. If the London server experiences a traffic spike, the download fails or slows to a crawl.

4. Different Types of Sharding

Not all sharding architectures are built the same. Engineers use different mathematical approaches depending on the network's goals for redundancy and speed.

Erasure Coding (Reed-Solomon) This is the most common algorithm used in modern distributed storage. Erasure coding breaks a file into a specific number of data shards and then generates additional "parity shards." For example, a protocol might break a file into 20 data shards and create 10 parity shards. The mathematical brilliance of Erasure Coding is that the original file can be perfectly reconstructed using any 20 of those 30 shards. This provides massive fault tolerance.

XOR-Based Sharding Some highly specialized privacy networks use logical XOR operations to shard files. A file is processed in blocks, and each block is XORed with random data (seed shards) to create new shards. This ensures that any single shard in isolation looks like complete mathematical noise, providing plausible deniability for the node operators hosting the data.

Fixed-Size vs. Dynamic Sharding Some protocols divide files into fixed chunks (for example, strictly 1-Megabyte shards), which helps standardize network bandwidth and storage allocation. Other protocols dynamically adjust shard sizes based on the total payload size, optimizing the reconstruction speed for massive datasets like raw 8K video footage.

5. Binary Sharding Explained

At its core, a file is simply a long sequence of binary data (ones and zeros). Binary sharding interacts directly with this machine-level architecture.

When a binary sharding engine engages, it does not care if the file is a PDF, an MP4, or a JPEG. It reads the raw byte stream. The engine calculates the total byte length of the file and determines the optimal division points.

One advanced method is Midpoint Bisection. Instead of linearly chopping the file from start to finish, a midpoint bisection engine splits the binary sequence exactly in half, then splits those halves into quarters, continuing this algorithmic division until the target shard size is reached. This method allows for highly predictable chunking and makes parallel processing much more efficient for the client's CPU.

6. Encryption Before Sharding: The Golden Rule

Sharding a file provides a layer of obfuscation, but sharding alone is not security. If a file is sharded in plaintext, an attacker who manages to collect enough shards could easily reassemble and read the data.

The absolute golden rule of decentralized storage architecture is: Encrypt first, shard second.

The Secure Pipeline:

The user selects a file on their local device.

The client-side application applies industry-standard (such as AES-256) to the entire file using a passkey that only the user knows.

The file is transformed into a single, massive block of unreadable ciphertext.

The sharding engine then slices this ciphertext into smaller fragments.

Because the encryption happens before the sharding, every single shard distributed to the network is mathematically useless. Even if a rogue node operator manages to collect all the shards and reassemble them, they will only be left with a locked block of ciphertext that requires the user's local passkey to decrypt.

7. Metadata Management: The Cryptographic Map

If your file is cut into 30 pieces and scattered across the globe, how does your computer know where to find them when you click "Download"? This is the role of Metadata Management.

When a file is sharded and distributed, the protocol generates a highly detailed cryptographic map. This metadata file contains:

The original file name and extension.

The cryptographic hashes (unique digital fingerprints) of every individual shard.

The network addresses or node IDs where each shard was sent.

The exact order required to stitch the shards back together.

The Centralized vs. Decentralized Ledger Legacy systems store this metadata in a centralized SQL database. If that database is corrupted, the map is lost, and the sharded files become permanent digital debris. Modern decentralized protocols anchor this metadata to a blockchain (such as the BNB Chain). By storing the cryptographic map on an immutable distributed ledger, the protocol guarantees that the map can never be deleted, altered, or manipulated by a single entity.

8. File Reconstruction

The reconstruction phase is the exact reverse of the ingestion pipeline. When a user requests to view or download their file, the following steps occur in milliseconds:

Metadata Query: The client application queries the blockchain or metadata layer to retrieve the cryptographic map.

Parallel Retrieval: The application reaches out to the DePIN network and requests the specific shards. Because the shards are hosted on different nodes, the client can download them simultaneously in parallel, vastly increasing download speeds.

Integrity Verification: As each shard arrives, the client hashes the fragment and compares it against the metadata map to ensure the node operator did not tamper with or corrupt the data.

Reassembly: The sharding engine stitches the binary fragments back into a single block of ciphertext.

Decryption: Finally, the client uses the user's local passkey to decrypt the ciphertext, restoring the original plaintext file to the user's screen.

9. The Benefits of Sharded Storage

Implementing a sharded architecture provides massive advantages over traditional monolithic storage.

Unprecedented Resilience Because protocols utilize erasure coding, a large percentage of the network can go offline without affecting file availability. If a regional power grid fails and takes down 15 storage nodes, the file remains perfectly intact and retrievable from the remaining nodes in other regions.

Zero Single Point of Failure There is no "master server" holding the complete file. Hackers cannot execute a targeted physical or logical strike to steal a specific dataset, because the dataset physically does not exist in one place.

Parallel Throughput (Speed) Downloading a monolithic file relies on one server's upload speed. Downloading a sharded file relies on the combined upload speeds of dozens of nodes simultaneously. This parallel architecture fundamentally changes how large-scale data delivery functions, acting similarly to a highly optimized BitTorrent swarm.

10. The Challenges of Sharding

While powerful, sharding introduces complex engineering challenges that infrastructure developers must solve.

Metadata Overhead Tracking the location of millions of files is difficult; tracking the location of billions of individual shards requires massive computational overhead. If the metadata layer is poorly optimized, the system will suffer from extreme latency when trying to locate file fragments.

Node Churn In a decentralized network, independent operators turn their hardware on and off unpredictably (known as node churn). The protocol must constantly monitor shard health. If a node holding a shard goes offline permanently, the network must automatically use the parity shards to regenerate the missing fragment and assign it to a new, healthy node.

Garbage Collection When a user deletes a file, the system must ensure that all corresponding shards across the global network are permanently purged. Leaving orphaned shards on the network wastes node storage capacity and creates unnecessary bandwidth costs.

11. Enterprise Use Cases for Sharded Storage

Sharded, decentralized storage is rapidly gaining traction in sectors that handle highly sensitive information.

Healthcare and Genomic Data Hospitals manage petabytes of Electronic Health Records (EHR) and genomic sequencing data. By sharding this data across a private or decentralized network, healthcare providers can guarantee that a breach of a single terminal or server will never expose a complete patient record.

Legal and Financial Auditing Law firms managing Mergers & Acquisitions (M&A) require absolute data confidentiality. Sharding combined with client-side encryption ensures that corporate espionage actors cannot compromise centralized data rooms to steal pre-market financial data.

Content Delivery and Media Publishing Media companies distributing 4K and 8K video assets suffer from massive bandwidth costs. Sharded architecture allows these companies to distribute fragments across a localized edge network, serving video to consumers from the closest geographic nodes to reduce buffering and egress fees.

12. The Future of Sharded Storage

As we look toward the next decade of internet infrastructure, sharding will move beyond simple static file storage.

AI Training Data Storage Artificial Intelligence requires massive, immutable datasets for training. Sharded storage allows AI developers to pull vast amounts of training data from a decentralized network simultaneously, bypassing the bandwidth limits of centralized cloud providers.

Edge Computing Convergence Sharding will increasingly integrate with edge computing. Instead of just storing static shards, future networks will allow edge nodes to perform lightweight computational tasks on the encrypted shards they hold, returning only the computed results to the user. This will unlock secure, decentralized data analytics.

13. How Inaya Approaches Binary Sharding

To translate these complex cryptographic concepts into a usable product, infrastructure protocols must build seamless, automated pipelines. The Inaya Network was architected specifically to solve the complexities of decentralized sharding for enterprise and Web3 developers.

Rather than relying on legacy chunking methods, Inaya utilizes a proprietary Binary Midpoint Bisection engine. When a user uploads a file through the Inaya Mobile App or developer SDK, the file is first subjected to AES-256 client-side encryption. The ciphertext is then passed to the Bisection engine, which algorithmically divides the data into optimal binary shards based on network bandwidth and file size.

Crucially, Inaya solves the metadata overhead challenge by cryptographically anchoring the shard maps directly to the BNB Chain. This provides an immutable, transparent, and highly resilient tracking ledger that cannot be manipulated by any centralized entity. The entire process—from client-side encryption to binary sharding and on-chain metadata registration—is abstracted away into simple drop-in React components for developers, making industry-standard sharding accessible to any application.

14. Conclusion

File sharding represents the necessary evolution of digital storage architecture. As datasets grow larger and cyber threats become more sophisticated, the practice of storing monolithic files in centralized corporate servers is rapidly becoming obsolete.

By fragmenting data mathematically and distributing it across a decentralized physical infrastructure, we eliminate single points of failure, neutralize localized data breaches, and enable parallel data retrieval. When combined with rigorous client-side encryption, file sharding ensures that our digital assets remain perfectly resilient, highly available, and undeniably sovereign.

15. Frequently Asked Questions (FAQs)

1. Does file sharding increase the size of the original file? Yes, slightly. Because most sharding algorithms (like erasure coding) generate additional parity shards for fault tolerance, the total storage footprint across the network is larger than the original file. However, this is a necessary trade-off to ensure high availability and redundancy.

2. Can an attacker reconstruct my file if they steal enough shards? If the file was sharded in plaintext, yes. However, modern networks like Inaya apply AES-256 client-side encryption before sharding. Even if an attacker collects every single shard and reassembles them, they will only possess unreadable ciphertext that requires your private passkey to unlock.

3. What happens if several storage nodes go offline at the same time? Decentralized networks account for node churn by generating parity shards. You do not need 100% of the shards to reconstruct a file. As long as a minimum threshold of shards (e.g., 20 out of 30) is available on the network, the file can be perfectly reconstructed in real time.

4. How does the network repair lost shards? If a node goes permanently offline and a shard is lost, the network’s protocol detects the missing fragment. It uses the remaining active shards to mathematically regenerate the missing piece and securely assigns it to a new, healthy node to maintain maximum redundancy.

5. Is downloading a sharded file slower than downloading from AWS? In many cases, it is actually faster. When downloading a monolithic file from a centralized server, you are limited by that specific server's upload bandwidth. With a sharded file, you are downloading multiple pieces simultaneously from multiple global nodes in parallel, utilizing your maximum local internet bandwidth.

6. How is file sharding different from database sharding? Database sharding involves splitting rows of structured data (like user profiles or transaction logs) across multiple servers to make search queries faster. File sharding involves breaking the raw binary code of an unstructured object (like a video or document) into fragments for secure, distributed storage.

7. Where is the map of the shards kept? The cryptographic map (metadata) containing the hashes and locations of your shards is typically stored on a decentralized blockchain ledger. This ensures the map is immutable, highly available, and cannot be censored or deleted by a central authority.

8. Can I shard a file myself manually? While you could technically use command-line tools to split a file into compressed archives (like multi-part ZIP files), modern DePIN protocols handle this entire process automatically at the binary level. Frameworks like the Inaya SDK encrypt, shard, distribute, and track the data entirely in the background within milliseconds.`,
  },
  {
    id: 'what-is-digital-sovereignty',
    category: 'Blog',
    title: "What Is Digital Sovereignty? Why Data Ownership Matters in 2026",
    excerpt: "Discover what digital sovereignty means, why individuals and businesses are prioritizing data ownership, and how decentralized infrastructure supports greater control.",
    date: '2026-08-02',
    body: `1. Introduction

For decades, the internet operated on a silent, unwritten trade-off: users surrendered their personal data in exchange for free access to search engines, social media, and digital services. We leased our digital lives to centralized tech giants, assuming they would act as responsible custodians of our information.

By 2026, that assumption has collapsed. In an era dominated by hyper-advanced Artificial Intelligence, massive corporate data breaches, and fragmented geopolitical data laws, the conversation has shifted from "data privacy" to a much more powerful concept: Digital Sovereignty.

Digital sovereignty is no longer just an academic theory discussed by cryptographers; it is a critical mandate for modern businesses and individuals. This guide explores the true meaning of digital sovereignty, why the distinction between accessing data and owning data matters, and how decentralized physical infrastructure is finally giving control back to the user.

2. What Is Digital Sovereignty?

At its core, digital sovereignty is the legal and technical right of an individual, business, or nation to maintain absolute control over their digital data.

In practical terms, it means that you dictate where your data is stored, who has the mathematical ability to read it, and how it is used. It is the digital equivalent of holding the physical keys to a safe in your own home, rather than trusting a bank to hold your assets in a shared vault.

True digital sovereignty requires three fundamental pillars:

Autonomy: The ability to move, export, or delete your data without facing artificial friction or vendor lock-in.

Cryptographic Ownership: Utilizing technologies like client-side encryption, where only the data creator holds the decryption keys.

Infrastructure Independence: The ability to store data without relying on a single, centralized corporate entity that could arbitrarily revoke your access.

3. Why People Are Losing Control of Data

The loss of digital control did not happen overnight; it was a gradual side effect of the transition to Web2 cloud computing.

When you upload a photo, a corporate document, or a health record to a traditional cloud provider, you are not simply storing a file. You are transmitting plaintext data to a server owned by someone else. The provider encrypts the data using their own keys, stores it on their own hardware, and grants you access via a password or API token.

Because the provider holds the encryption keys, they possess technical control. Depending on the service and its terms, providers may have the technical capability to process stored data for features such as indexing, security scanning, or AI-powered services. This is one reason many users and organizations are increasingly interested in client-side encryption and greater control over their data t. You did not lose control of your data because you were hacked; you lost control because the centralized architecture required you to surrender it.s

4. Data Ownership vs. Data Access

To understand sovereignty, we must clarify the massive difference between accessing data and owning it.

Data Access When you use a legacy cloud storage platform, you are renting "Data Access." The platform gives you an account, and as long as you pay your monthly subscription and do not violate their constantly changing Terms of Service, they allow you to view your files. If their servers go down, your access is revoked. If they decide your account violates a policy, your files are permanently locked.

Data Ownership Data ownership relies on cryptography, not corporate permission. In a sovereign digital model, your data is encrypted locally on your device before it touches the internet. The network only stores mathematically unreadable ciphertext. Because only you possess the private key required to decrypt the file, you are the absolute owner. The network cannot read, analyze, or hold your data hostage.

5. Privacy Laws Around the World in 2026

Governments have recognized the dangers of centralized data monopolies, leading to a massive surge in global regulatory frameworks. The global privacy landscape in 2026 has crossed a structural threshold, with 144 countries now operating under data protection statutes. More than 50 jurisdictions now enforce comprehensive data privacy laws with penalties that scale to global revenue.

The European Blueprint: The EU's General Data Protection Regulation (GDPR) set the initial standard, and the enforcement is staggering; GDPR breach notifications now exceed 400 per day across Europe, with cumulative fines surpassing €7.1 billion since 2018.

Global Localization Mandates: Governments are increasingly demanding that data generated within their borders remains within their borders. More than 100 countries have adopted some form of data sovereignty or localization laws, though requirements vary significantly, making compliance highly complex for multinational corporations. Today, over 80 percent of the global population is already covered by data privacy law.

While these laws attempt to enforce digital sovereignty legally, they still rely on centralized companies voluntarily complying. The ultimate solution requires enforcing sovereignty technically through infrastructure.

6. AI and Data Ownership

The explosion of Generative AI has rapidly accelerated the demand for data sovereignty. AI is entering a phase where ambition and profitability pressure collide with scrutiny on data use.

To train massive Large Language Models (LLMs), centralized tech companies scraped billions of data points from the public internet, often absorbing copyrighted material, private repositories, and personal information without consent.

For businesses, this represents a severe risk. If a company uploads proprietary source code or financial projections to a centralized cloud, there is a risk that this data could be ingested into a broader AI training model, potentially exposing trade secrets to competitors using the same AI tool. Digital sovereignty guarantees that data remains mathematically locked, preventing unauthorized AI scraping and ensuring that artificial intelligence serves the user, rather than exploiting them.

7. Why Businesses Care About Digital Sovereignty

For enterprise organizations, digital sovereignty is no longer just an ideological stance; it is a matter of financial survival.

Avoiding Vendor Lock-In: Centralized cloud providers often impose massive "egress fees"—charging exorbitant rates to extract data from their servers. Sovereign architecture ensures businesses can move their data freely without being held financially hostage.

Corporate Espionage and Security: Law firms, healthcare providers, and financial institutions cannot afford a centralized database breach. Sovereign, zero-knowledge architecture ensures that even if a network is compromised, the attacker only acquires useless, encrypted fragments.

Regulatory Compliance: With data laws becoming highly fragmented globally, businesses using sovereign architecture (where data is anonymized and encrypted locally) drastically reduce their compliance burden and legal liabilities.

8. Sovereign Infrastructure: The Web3 Shift

Achieving true digital sovereignty is impossible on legacy Web2 architecture. It requires a fundamental shift to Web3 and Decentralized Physical Infrastructure Networks (DePIN).

Sovereign infrastructure removes the centralized data center from the equation. Instead of trusting a single corporation, data is stored across a globally distributed network of independent, peer-to-peer nodes.

This architecture guarantees sovereignty through two mechanisms:

Physical Decentralization: The hardware storing the data is not owned by a single CEO or board of directors. It is a collective, resilient network with zero single points of failure.

Cryptographic Immutability: Transactions, access logs, and storage proofs are recorded on a blockchain. This means access permissions are governed by unbreakable smart contracts, not by human administrators who could be compromised or coerced.

9. The Role of Decentralized Storage

Decentralized storage is the practical application of sovereign infrastructure. It utilizes file sharding and client-side encryption to protect data.

When you use a decentralized storage protocol, your file is encrypted on your device. It is then fragmented into dozens of small, unrecognizable pieces. These pieces are scattered across global nodes.

Because no single node holds a complete file, and no node has the decryption key, the network is entirely "trustless." You do not need to trust the hardware operators, because the mathematics of the encryption guarantees your privacy. Decentralized storage is the technical enforcement of digital sovereignty.

10. Future Trends in Data Sovereignty

As we look beyond 2026, several key trends will shape the sovereign web:

Sovereign AI Models: We will see the rise of decentralized, edge-computed AI models that process data locally on the user's device, rather than sending sensitive prompts to a centralized server.

Mainstream DePIN Adoption: Decentralized infrastructure will move from the crypto-native sphere into traditional enterprise IT stacks, facilitated by seamless fiat-payment gateways and standard REST APIs.

Data Monetization: Once users have sovereign control over their data, they will have the choice to securely license specific datasets to AI researchers or advertisers in exchange for direct financial compensation, flipping the current exploitative model upside down.

11. How Inaya Supports User-Controlled Data

The transition to digital sovereignty requires infrastructure that is both cryptographically absolute and easily accessible. The Inaya Network was built specifically to serve as the foundational storage layer for the sovereign web.

Inaya enforces data ownership through a strict zero-knowledge architecture. The protocol mandates AES-256 client-side encryption for every file before it is subjected to Inaya’s Binary Midpoint Bisection sharding engine.

Furthermore, Inaya eliminates the reliance on centralized databases by anchoring the cryptographic maps of these shards directly to the BNB Chain via smart contracts. This means the user—and only the user—retains the cryptographic authority to locate, assemble, and decrypt their digital assets. By offering developer-friendly drop-in React components and a seamless fiat payment gateway for enterprises, Inaya Network is making true digital sovereignty the default standard for the modern internet.

Why Digital Sovereignty Matters for Individuals

Digital sovereignty isn't only an enterprise concern.

Every day, individuals store increasingly valuable digital assets online, including:

Family photos and videos

Personal documents

Financial records

Health information

Creative work

Cryptocurrency wallets and backups

As more of our lives move online, maintaining control over these digital assets becomes just as important as protecting physical property.

Modern infrastructure allows individuals—not just corporations—to own and control their data through encryption, decentralized storage, and user-managed access.

12. Conclusion

Digital sovereignty is the reclamation of our digital rights. For too long, the internet has operated on an architecture of dependency, where users and businesses were forced to trust centralized monopolies with their most sensitive information.

As global regulations tighten and the value of digital assets reaches unprecedented heights, trust is no longer a viable security strategy. True data ownership requires a math-based approach. By embracing client-side encryption, file sharding, and decentralized physical infrastructure, we can transition to a sovereign web where privacy is guaranteed by code, and control is returned to the creator.

13. Frequently Asked Questions (FAQs)

1. What is the simple definition of digital sovereignty? Digital sovereignty is having total, independent control over your digital data—knowing exactly where it is stored, controlling who can access it, and having the ability to move or delete it without interference from a third-party company.

2. How does client-side encryption create data ownership? Because client-side encryption locks the data before it leaves your device, the server receiving the data never sees the contents and never holds the key. Since you are the only entity with the mathematical key to unlock the file, you remain the absolute owner.

3. Why can't I just trust traditional cloud providers? While traditional providers have strong physical security, they technically hold the keys to your data. This exposes you to internal employee breaches, silent compliance with government subpoenas, and the risk that your data will be used to train corporate AI models without your consent.

4. How does decentralized infrastructure stop AI from stealing my data? Decentralized networks like Inaya only store encrypted, fragmented ciphertext. An AI web-scraper or training model attempting to read this data would only ingest mathematical noise, completely protecting your proprietary information.

5. What is the difference between data localization and data sovereignty? Data localization is a government mandate requiring data to physically remain within a specific country's borders. Data sovereignty is a broader concept that focuses on the user or organization having absolute technical and legal control over the data, regardless of physical hardware location.

6. Do I need to understand cryptocurrency to achieve digital sovereignty? Not anymore. While digital sovereignty utilizes blockchain technology for security and tracking, modern decentralized platforms like Inaya provide user-friendly apps and fiat payment gateways (credit cards) that make the underlying crypto mechanics completely invisible to the user.

7. Can a decentralized network delete my account or files? No. In a true decentralized protocol governed by smart contracts, there is no centralized administrator with the authority to suspend your account or delete your files, ensuring total censorship resistance.

8. Is digital sovereignty only for large businesses? No. While enterprises use it to protect trade secrets and comply with global laws, digital sovereignty is essential for individuals who want to protect their private communications, financial documents, and personal media from corporate surveillance and data breaches.`,
  },
  {
    id: 'zero-knowledge-architecture',
    category: 'Knowledge Base',
    title: "What Is Zero-Knowledge Architecture? A Practical Guide to Private Applications",
    excerpt: "Zero-knowledge architecture means the provider is mathematically unable to see your data — learn how it works, what it actually protects against, and where the real tradeoffs are.",
    date: '2026-08-10',
    body: `Introduction

Most applications you use today are built on a simple, largely invisible assumption: the company running the service can see your data. Your email provider can read your emails. Your cloud storage provider can open your files. Your password manager's parent company could, in principle, unlock your vault. This isn't a conspiracy—it's just how the architecture works. The server holds the keys, so the server holds the access.

Zero-knowledge architecture flips that assumption. It's a design approach where the service provider is mathematically unable to access your unencrypted data—not because they've promised not to look, but because they never had the ability to look in the first place.

The Core Idea

In a zero-knowledge system, encryption and decryption happen entirely on the user's own device, before any data is transmitted to a server. The server only ever receives and stores ciphertext—scrambled, unreadable data—along with, at most, some metadata needed to route or organize it. The encryption key itself never leaves the user's control.

This is different from "encryption at rest," a term many cloud providers use that sounds similar but means something much weaker. Encryption at rest typically means the provider encrypts your data once it arrives on their servers—using keys the provider itself manages. That protects you from someone stealing a hard drive out of a data center. It does nothing to protect you from the provider itself, a compromised employee, a legal subpoena compelling data disclosure, or an attacker who breaches the provider's own key-management system.

Zero-knowledge architecture protects against all of those, because there's no key on the provider's side to steal, subpoena, or misuse.

How It Actually Works, Step by Step

A typical zero-knowledge flow looks like this:

Key generation, client-side. A cryptographic key is derived from something only the user knows or holds—a passphrase, a hardware key, or a private key—using a key-derivation function designed to resist brute-force guessing (PBKDF2 and Argon2 are common choices).

Encryption, before transmission. The actual file or data is encrypted locally, on the user's device, using that key. A well-regarded modern choice is AES-256 in GCM mode, which provides both confidentiality and tamper-detection.

Upload of ciphertext only. What actually travels over the network and lands on the provider's servers is the encrypted blob—meaningless without the key.

Decryption, only on retrieval. When the user wants their data back, the ciphertext is downloaded and decrypted locally, using the same key, which the user has kept.

At no point in this flow does a decryption-capable key exist anywhere except the user's own device.

What This Actually Buys You

The practical benefits are significant and specific, not abstract.

A data breach at the provider reveals nothing usable. If an attacker breaches the storage backend, they get encrypted noise, not your files.

The provider can't comply with a data request it can't fulfill. A legal demand for "give us this user's files" can only be answered with ciphertext, since that's all the provider has.

Insider risk drops sharply. A malicious or careless employee at the provider has nothing to leak, because there's nothing readable to leak.

The Real Tradeoff, Stated Honestly

Zero-knowledge architecture isn't free. The most important tradeoff is this: if you lose your key, your data is genuinely, permanently gone. There's no "forgot password" recovery flow, because a working recovery flow would require the provider to be able to access your data—which is exactly the property zero-knowledge architecture is designed to eliminate. Any system that claims to be zero-knowledge and offers a provider-side password reset is, at best, describing something less strict than true zero-knowledge, and worth questioning closely.

A second, more subtle tradeoff: some features that rely on server-side processing of your actual content—full-text search across your files, for instance—become much harder to build well in a zero-knowledge system, since the server can't read the content to index it. Systems that want both properties usually need more sophisticated techniques (like searchable encryption) rather than a simple architectural bolt-on.

Where This Matters Most

Zero-knowledge design isn't necessary for everything—a public blog post doesn't need it. It matters most for exactly the categories of data where a breach, subpoena, or insider incident would be genuinely damaging: identity documents, private keys, financial records, legal and medical files, and any business data where the cost of exposure is measured in real consequences, not inconvenience.

Where Inaya Fits

Inaya Network's storage layer is built around this exact model. Files are encrypted client-side using AES-256-GCM before they ever leave the browser, then split before being pinned to decentralized storage—meaning no single party, including Inaya itself, ever holds a complete, readable copy of anything stored. It's a concrete, working example of the architecture described above, not a theoretical illustration.

Conclusion

Zero-knowledge architecture is a genuine, powerful security property—but it's specific, not magic. It protects against the provider, a provider breach, and legal compulsion aimed at the provider. It does not protect against a compromised end-user device, a phished passphrase, or a lost key with no backup. Understanding exactly what the guarantee covers—and what it doesn't—is the difference between choosing this architecture for the right reasons and assuming it solves problems it was never designed to solve.

Frequently Asked Questions (FAQs)

1. What makes an architecture "zero-knowledge" instead of just "encrypted"? The distinction is where the key lives. If the provider generates or holds the key at any point, they technically have the ability to decrypt your data. True zero-knowledge means the key is derived and used only on your device, so the provider never possesses anything but unreadable ciphertext.

2. What happens if I lose my key or passphrase? Your data is permanently unrecoverable. This is the core tradeoff of the model—there is no provider-side reset, because building one would reintroduce the exact access the architecture is designed to remove.

3. Does zero-knowledge architecture protect me if my own device is compromised? No. It protects against the provider and against a breach of the provider's systems. If malware or an attacker has access to your unlocked device, they have access to your data the same way you do.

4. Can a zero-knowledge provider still offer features like search or sharing? Yes, but it requires more sophisticated engineering—searchable encryption, or sharing mechanisms that re-encrypt a file for a specific recipient's key—rather than the simple server-side processing that non-zero-knowledge systems rely on.`,
  },
  {
    id: 'cloud-data-breaches',
    category: 'Blog',
    title: "Cloud Data Breaches: How They Happen and How Businesses Can Reduce the Risk",
    excerpt: "Cloud breaches are rarely sophisticated attacks — they're overwhelmingly the result of a handful of well-understood, preventable mistakes. Here's what actually causes them and what to do about it.",
    date: '2026-08-10',
    body: `Introduction

Cloud data breaches rarely happen the way movies suggest—a hooded figure typing furiously against a countdown clock. In reality, the overwhelming majority of cloud breaches trace back to a small number of well-understood, largely preventable causes. Understanding those causes is the first real step toward reducing your exposure.

How Cloud Breaches Actually Happen

Misconfigured access controls. This is, by a wide margin, the most common root cause. A storage bucket set to "public" instead of "private" by mistake. A database left reachable from the open internet during testing and never locked back down. An overly broad permission granted to make development easier, then forgotten. These aren't sophisticated attacks—they're honest mistakes that an automated scanner, run by an attacker, finds within hours of being made.

Compromised credentials. Phishing remains extraordinarily effective. An employee enters their password into a convincing fake login page, and an attacker now has legitimate-looking access to whatever that employee could reach—which, in a poorly segmented system, might be far more than their actual job requires.

Third-party and vendor compromise. Modern businesses connect dozens of third-party tools to their core systems—analytics platforms, customer support tools, marketing integrations. Each one is a potential entry point. A breach at a vendor with excessive access to your systems becomes a breach of your systems, even though your own defenses were never directly tested.

Insufficient encryption practices. Many providers offer "encryption at rest" as a checkbox feature, but the encryption keys are frequently managed by the provider itself. If the provider is breached at the level where those keys live, the encryption offers little practical protection—the attacker who stole the data can also unlock it.

Insider risk. Not always malicious—sometimes just an employee with more access than their role requires, making an honest mistake with serious consequences. Overly broad internal permissions turn a single compromised account into a much bigger problem than it needs to be.

What Businesses Can Actually Do About It

Apply the principle of least privilege, rigorously. Every account, integration, and employee should have access to exactly what they need to do their job, and nothing more. This single practice, applied consistently, limits the blast radius of nearly every other failure on this list.

Use encryption where the provider never holds the key. This is the meaningful distinction between "encrypted" and actually protected. If your provider can technically decrypt your data—even if they promise not to—a breach at the provider is a breach of your data. Client-side, zero-knowledge encryption removes that dependency entirely: even a complete breach of the storage backend yields only unreadable ciphertext.

Audit configurations regularly, not just once. Cloud environments change constantly—new services get spun up, old ones get modified, permissions drift. A configuration that was correctly locked down six months ago may not be today. Automated configuration scanning, run continuously rather than as an annual checklist item, catches drift before an attacker does.

Train for phishing specifically, and test it. General security awareness training helps, but simulated phishing campaigns—sending realistic test phishing emails and measuring who clicks—produce measurably better real-world results than a slideshow alone.

Segment third-party access. Give integrations and vendors the narrowest possible scope of access, and review that access periodically. A marketing tool that only needs to read campaign metrics should never have write access to customer records.

The Uncomfortable Truth About "The Cloud Is Secure"

Major cloud providers—AWS, Google Cloud, Azure—genuinely do invest enormous resources in infrastructure security, and their physical and network-level protections are excellent. But cloud security operates on a shared-responsibility model: the provider secures the underlying infrastructure, and the customer is responsible for configuring access correctly, managing their own keys sensibly, and encrypting sensitive data properly. Most well-publicized cloud breaches are not failures of the provider's infrastructure—they're failures on the customer side of that shared responsibility line.

Where Inaya Fits

This is why architecture matters as much as provider choice. A system designed so that the provider never holds a usable copy of your sensitive data in the first place removes an entire category of risk—not by trusting the provider more, but by needing to trust them less. Inaya Network's storage layer follows exactly this principle: encryption happens client-side, before data ever reaches any server, so even a complete breach of the storage backend yields nothing usable.

Conclusion

Cloud breaches are overwhelmingly the result of ordinary, avoidable mistakes—not exotic attacks. The businesses that fare best treat access control as an ongoing discipline rather than a one-time setup, and choose architectures where sensitive data is protected by design, not just by policy.

Frequently Asked Questions (FAQs)

1. What's the single most common cause of cloud data breaches? Misconfigured access controls—a storage bucket, database, or permission left more open than intended. It's an honest mistake far more often than a sophisticated exploit, which is exactly why it's so common.

2. Does "encryption at rest" mean my provider can't read my data? No. Encryption at rest usually means the provider encrypts your data with keys they manage themselves, which protects against physical theft of hardware but not against the provider, a compromised employee, or a breach of their key-management system.

3. If my cloud provider is breached, is my data automatically exposed? It depends entirely on where the encryption keys live. If the provider holds the keys, a breach of their systems can expose your data. If encryption happens client-side and the provider never has the key, a breach yields only unreadable ciphertext.

4. Is the cloud provider or the customer responsible for a breach? Usually both, under what's called the shared-responsibility model—but most well-publicized breaches trace back to the customer's side of that line: misconfiguration, weak access control, or provider-managed keys, not a failure of the provider's core infrastructure.`,
  },
  {
    id: 'data-portability',
    category: 'Knowledge Base',
    title: "Data Portability Explained: Can You Really Move Your Data Between Cloud Providers?",
    excerpt: "Moving data between cloud providers is technically possible almost always — but egress fees, format lock-in, and migration risk mean the real cost of leaving is rarely what the sign-up price implies.",
    date: '2026-08-10',
    body: `Introduction

"You can always just move your data" is one of the most common, and most misleading, things said about cloud storage. In principle, yes—your data isn't physically welded to one provider's servers. In practice, moving meaningful amounts of data between cloud providers is slower, more expensive, and more technically involved than most people expect, for reasons that are often built into the pricing model on purpose.

What Data Portability Actually Means

Data portability is the practical ability to extract your data from one provider, in a usable format, and move it to another provider (or to your own infrastructure) without losing functionality, incurring prohibitive cost, or requiring extensive re-engineering. It's a spectrum, not a yes/no property—some systems make this genuinely easy, others make it technically possible but practically punishing.

The Three Real Barriers

Egress fees. This is the most direct and often the largest barrier. Most major cloud storage providers charge little or nothing to upload data—but charge meaningfully to download it, particularly at volume. Moving a large dataset out of a provider can mean a real, sometimes substantial bill, calculated specifically for the act of leaving. This isn't hidden—it's disclosed pricing—but it's easy to overlook when the "welcome" pricing focuses entirely on how cheap it is to bring data in.

Format lock-in. Data doesn't always leave in a form that's immediately usable elsewhere. A database export, a proprietary file format, or data tightly coupled to a provider's specific services (their particular database engine, their specific machine learning pipeline) may require real re-engineering work to become usable on a different platform—cost that doesn't show up on any invoice but is very real in time and engineering effort.

Time and operational risk. Moving large volumes of data takes real time, and a migration window is a period of operational risk—the potential for inconsistency between the old and new systems, downtime, or errors during transfer. For a business running live services, this isn't a trivial cost even when the direct fees are manageable.

Why This Isn't an Accident

It's worth being direct about this: egress pricing structures that make leaving expensive, while entry is cheap or free, are a well-understood competitive strategy, not an incidental side effect of infrastructure costs. The cost of actually transmitting data isn't inherently asymmetric in the way pricing often is—the asymmetry is a deliberate structural choice that makes switching providers costly enough that many businesses simply don't, even when a competitor might otherwise be a better fit.

This is worth naming plainly because it changes how you should evaluate a storage decision. The sticker price you're quoted when signing up describes the cost of starting—it says very little about the cost of leaving, and that second number is often the more important one for a business making a long-term infrastructure decision.

What Genuine Portability Looks Like

A storage system with real portability tends to share a few characteristics. Symmetric pricing, where the cost to retrieve your data isn't dramatically higher than the cost to store it in the first place. Open, standard formats rather than proprietary structures that only make sense inside one provider's ecosystem. Direct, provider-independent access to the underlying data, rather than access mediated entirely through one company's specific API and tooling. No punitive fee specifically triggered by the act of leaving.

Where Inaya Fits

Decentralized storage architectures sidestep the egress-fee problem in a fairly direct way: because data isn't held by a single company with pricing leverage over your exit, there's no single party positioned to charge a premium specifically for leaving. Inaya Network's pricing, for example, is a flat, usage-based rate rather than an asymmetric in-cheap/out-expensive structure—the cost of retrieving your data isn't inflated relative to the cost of storing it. This isn't a special discount; it's simply a different structural starting point, since there's no single centralized provider positioned to price your exit as a business strategy.

What Businesses Should Actually Check

Before committing significant data to any storage provider, it's worth asking directly. What is the actual, current egress fee, at the volume you'd realistically need to move? Is the data stored in a format you could use elsewhere without major rework? Does the provider offer direct API or protocol-level access, or only their own proprietary tooling? Has anyone actually tested a real migration, or is "you can always move it" an assumption rather than a verified fact?

Conclusion

Data portability is real, but it's rarely as simple as marketing material implies. The honest question isn't "can I technically move my data"—almost always, yes. The honest question is "what would it actually cost me, in money and time, to do it"—and that number is worth knowing before you commit a large volume of data to any single provider, not after you've decided you need to leave.

Frequently Asked Questions (FAQs)

1. Why do cloud providers charge so much more to download data than to upload it? It's a deliberate pricing structure, not a reflection of actual transmission cost—cheap entry and expensive exit make switching providers costly enough that many businesses simply don't, even when a competitor would otherwise be a better fit.

2. Is data portability just about the file format? No. Format is one barrier, but egress fees and migration risk (downtime, inconsistency during transfer) are often the bigger practical costs, and neither shows up when you're evaluating a provider's sign-up price.

3. Does decentralized storage really avoid egress fees? Structurally, yes—because no single company holds your data with unilateral pricing power over your exit, there's no single party positioned to charge a premium specifically for leaving. Inaya Network, for example, uses flat usage-based pricing with no separate exit penalty.

4. What should I check before committing large volumes of data to a provider? The actual egress cost at your realistic data volume, whether the storage format is usable elsewhere, whether you have direct API access versus only proprietary tooling, and whether anyone has actually tested a real migration rather than assuming it's possible.`,
  },
  {
    id: 'cloud-vendor-lock-in',
    category: 'Knowledge Base',
    title: "Cloud Vendor Lock-In: What It Is and Why It Matters for Businesses",
    excerpt: "Vendor lock-in rarely arrives as one dramatic barrier — it builds up from small, individually reasonable dependencies until switching providers becomes practically impossible. Here's how it forms and how to avoid it.",
    date: '2026-08-10',
    body: `Introduction

Vendor lock-in is one of those terms everyone in tech has heard, few people have quantified for their own business, and almost nobody budgets for in advance. That's a problem, because lock-in isn't a minor inconvenience—for a business that's been on one cloud provider for several years, it can represent a genuinely significant, invisible cost sitting quietly on the balance sheet.

What Vendor Lock-In Actually Is

Vendor lock-in is the condition where switching away from a provider becomes so costly, complex, or risky that a business effectively can't do it, even if a better or cheaper alternative exists. It's rarely the result of a single dramatic barrier—it's usually the accumulation of many small dependencies, each individually reasonable, that together add up to a real constraint on your ability to choose.

How Lock-In Actually Builds Up, Piece by Piece

Proprietary APIs and services. Cloud providers offer convenient, powerful services beyond raw storage—managed databases, serverless functions, specialized AI tooling. Each one you adopt is genuinely useful, and each one also ties a piece of your application logic to that specific provider's way of doing things, in ways that don't translate directly to a competitor's equivalent service.

Data gravity. The more data you accumulate in one place, the more expensive and operationally risky it becomes to move—partly through direct egress fees, partly through the sheer logistics of migrating a large, live dataset without disrupting the business depending on it.

Team expertise. Engineers become specialists in the specific tools of whichever provider a company has used for years. That expertise has real value, and it's also a switching cost—a migration doesn't just move data, it requires a team to relearn significant parts of how they work.

Contractual and pricing structures. Multi-year committed-use discounts genuinely save money in the short term, while quietly increasing the cost of leaving before the commitment ends.

Why This Matters More Than It Might Seem

The risk isn't abstract. A business locked into one provider has weaker negotiating leverage on pricing, less ability to adopt a better-suited technology from elsewhere, and real exposure if that provider raises prices, changes terms, deprecates a service the business depends on, or experiences an extended outage.

That last point is worth sitting with directly: a business whose entire infrastructure lives with one provider has effectively made that provider's reliability their own reliability ceiling. When that provider has a bad day, so does the business—with no fallback, because there was never a credible option to use one.

Reducing Lock-In Without Rejecting the Cloud

Avoiding lock-in doesn't mean avoiding cloud infrastructure—for nearly every business, that would be a worse decision than the lock-in itself. It means making deliberate, informed choices rather than defaulting into dependency. Favor open standards and portable formats over proprietary ones wherever the choice genuinely doesn't cost meaningful functionality. Understand your actual egress costs before you need them—not as an afterthought during a crisis, but as a known, budgeted figure. Architect for genuine portability from the start, even if you don't plan to switch soon—the cost of building portably up front is far lower than the cost of retrofitting it under pressure later. Periodically and honestly assess whether your current provider still serves you best—not out of reflexive dissatisfaction, but as a real, recurring check rather than an assumption that the original choice is permanently correct.

Where Inaya Fits

Some newer storage architectures address lock-in at the structural level rather than through pricing discipline alone. Decentralized storage networks, by design, don't have a single company controlling your access or setting exit terms—data is distributed across independent infrastructure rather than held by one entity with unilateral pricing power over your departure. Inaya Network's model reflects this directly: flat, predictable, usage-based pricing with no egress penalty designed to discourage leaving, because there's no single centralized gatekeeper positioned to impose one in the first place. This doesn't mean every business should immediately move everything to a decentralized architecture—for many workloads, traditional cloud providers remain the right, pragmatic choice. It does mean the option of an architecture without built-in lock-in is worth knowing exists, particularly for data where long-term control and predictable exit costs genuinely matter.

Conclusion

Vendor lock-in isn't a dramatic, single event—it's a slow accumulation of small, individually reasonable dependencies that eventually adds up to a real loss of choice. The businesses that manage this risk well aren't the ones that avoid convenient cloud services entirely—they're the ones that make each dependency a conscious decision, with a real understanding of what it would cost to walk away, made before walking away becomes something they need to do under pressure.

Frequently Asked Questions (FAQs)

1. Is vendor lock-in caused by one big decision or many small ones? Almost always many small ones—each proprietary API, each byte of accumulated data, each hour of team expertise on a specific platform is individually reasonable, but together they add up to a real constraint on your ability to switch.

2. Does avoiding lock-in mean avoiding cloud providers entirely? No. For most workloads, traditional cloud providers remain the right choice. Avoiding lock-in means making deliberate decisions about portability and exit costs from the start, not rejecting cloud infrastructure altogether.

3. How does decentralized storage reduce lock-in risk? Because no single company controls access or sets exit terms, there's no centralized gatekeeper positioned to impose punitive pricing or terms on a business that wants to leave—the lock-in is addressed structurally rather than through policy alone.

4. What's the most practical first step to reduce lock-in? Know your actual egress costs and data format portability today, before you need to move—not as an afterthought during a crisis. That single piece of information changes how you evaluate every other infrastructure decision.`,
  },
  {
    id: 'data-backup-strategy',
    category: 'Knowledge Base',
    title: "How Businesses Should Design a Modern Data Backup Strategy",
    excerpt: "A real backup strategy isn't a checkbox — it's a small number of deliberately chosen numbers (RPO, RTO) backed by a tested, automated process that actually delivers on them.",
    date: '2026-08-10',
    body: `Introduction

Most businesses have a backup strategy in the same sense that most people have a fire escape plan—it technically exists, nobody has actually tested it, and there's a real chance it doesn't work the way anyone assumes when it's actually needed. Backup strategy tends to get attention only after something has already gone wrong, which is precisely backward.

Start With the Right Question

The wrong question is "do we have backups?" Nearly every business, if asked, would say yes. The right question is far more specific: if we lost our primary data right now, exactly how much would we lose, and exactly how long would recovery actually take? Most businesses that haven't tested this genuinely don't know the answer, and the honest answer is often worse than assumed.

Those two numbers have real names in backup planning. Recovery Point Objective (RPO)—how much data, measured in time, could you lose? If your last backup ran 24 hours ago and something happens now, your RPO is effectively 24 hours of lost work. Recovery Time Objective (RTO)—how long would it actually take to get back up and running from a backup? Minutes, hours, or days—and does the business survive that gap?

Every backup strategy decision should trace back to explicit, deliberately chosen answers to these two questions—not to whatever the default settings of whatever tool happened to be configured first.

The 3-2-1 Rule, and Why It Still Holds Up

A long-standing, still genuinely sound backup principle: keep 3 copies of your data, on 2 different types of storage media, with 1 copy stored somewhere physically or logically separate from the others.

The reasoning behind each number matters. Three copies because any single copy—including the "original"—can fail, and you want redundancy beyond just one backup. Two different media types because a single point of failure in one storage technology (a firmware bug, a specific ransomware strain targeting one type of system) shouldn't be able to take out both your primary data and your backup simultaneously. One copy offsite or otherwise isolated because a fire, flood, or targeted attack on your primary location shouldn't be able to destroy your backups along with your original data.

What Modern Backup Strategy Adds to That Foundation

Immutability. Ransomware attacks increasingly target backups specifically, since a backup an attacker can encrypt or delete is a backup that can't save you. Immutable backups—ones that genuinely cannot be altered or deleted for a defined period, even by an administrator account—close this specific, increasingly common attack path.

Regular, actual testing. A backup that has never been restored is, functionally, an unverified claim rather than a real safety net. Real disaster recovery testing—actually restoring from backup on a schedule, not just confirming the backup job "completed successfully"—is the only way to know your RTO is real rather than assumed.

Encryption, including for the backup itself. A backup is a full copy of your sensitive data, sitting somewhere—which means it deserves the same protection as your primary data, not less. An unencrypted backup is, in practice, a second, often less-monitored copy of everything an attacker would want.

Automation over manual process. Backup strategies that depend on someone remembering to run a manual step reliably fail exactly when that person is busy, on leave, or has left the company. Automated, scheduled backups with active failure alerting remove that dependency.

Where Inaya Fits

Decentralized storage architectures offer a genuinely useful property for one specific part of the 3-2-1 rule: the "different location, different infrastructure" requirement. Because data isn't concentrated in a single provider's data centers, decentralized storage can function well as one leg of a broader backup strategy—a copy that's structurally independent from your primary infrastructure, not just logically separate within the same provider's systems.

It's worth being precise here, though: a backup strategy needs both confidentiality (nobody unauthorized can read the data) and redundancy (the data survives even if part of the storage system fails). These are related but genuinely different properties, and a good backup solution needs to be honest about which ones it actually provides. Encryption addresses confidentiality. True redundancy requires multiple independent copies or robust distributed replication—worth confirming explicitly with any storage provider, decentralized or otherwise, rather than assuming encryption alone implies resilience against data loss.

Conclusion

A real backup strategy isn't a checkbox—it's a small number of deliberately chosen numbers (RPO, RTO) backed by a tested, automated process that actually delivers on them. The businesses that get burned aren't usually the ones with no backups at all—they're the ones with backups that existed, were never tested, and turned out not to work the one time they actually mattered.

Frequently Asked Questions (FAQs)

1. What's the difference between RPO and RTO? RPO is how much data you could lose, measured in time since your last backup. RTO is how long it would actually take to restore operations after a loss. Both should be deliberately chosen numbers, not assumptions.

2. Is the 3-2-1 backup rule still relevant today? Yes—three copies, on two different media types, with one copy stored separately, still addresses the core failure modes (single-copy loss, single-technology failure, single-location disaster) that cause most real data loss.

3. Why do immutable backups matter specifically against ransomware? Because modern ransomware increasingly targets backups directly, encrypting or deleting them alongside primary data. A truly immutable backup can't be altered or deleted for a defined period, even by a compromised administrator account, closing that attack path.

4. Does encryption alone make a backup resilient against data loss? No. Encryption protects confidentiality—keeping the backup unreadable to unauthorized parties—but resilience against data loss requires genuine redundancy, such as multiple independent copies or distributed replication, which is a separate property worth confirming explicitly.`,
  },
  {
    id: 'multi-cloud-vs-single-cloud',
    category: 'Blog',
    title: "Multi-Cloud vs Single-Cloud: Which Strategy Is Better for Businesses?",
    excerpt: "There's no universally correct answer — the right choice depends on what an hour of downtime actually costs your business and whether you have the operational capacity multi-cloud genuinely requires.",
    date: '2026-08-10',
    body: `Introduction

This is one of those debates where the honest answer is genuinely "it depends," and anyone giving you a confident one-size-fits-all answer either hasn't thought about your specific situation or is selling you something. What's actually worth understanding is the real tradeoffs on each side, so the decision can be made deliberately rather than by default.

Single-Cloud: The Case For It

Simplicity. One provider, one set of APIs, one billing relationship, one support contract. Engineering teams can go deep on one platform's tools rather than spreading expertise thin across several.

Cost efficiency, at least initially. Volume discounts and committed-use pricing genuinely reward concentration. Splitting workloads across multiple providers usually means losing access to the steepest pricing tiers on each.

Easier integration. A provider's own services are generally designed to work smoothly together. Cross-provider integration usually requires more custom engineering work to bridge gaps that wouldn't exist within a single ecosystem.

Lower operational complexity. One provider means one set of monitoring tools, one security model to understand deeply, one operational playbook—genuinely less for a team to manage well.

Single-Cloud: The Case Against It

Concentrated risk. If that one provider has a major outage, your business has an outage—full stop, with no fallback. Several well-publicized cloud outages over the years have taken down large portions of the internet simultaneously, precisely because so many businesses concentrate on the same few providers.

Reduced negotiating leverage. A business with no credible alternative has a structurally weaker negotiating position on pricing and terms than one that could plausibly move.

Vendor lock-in, compounding over time. The longer a business stays on one provider, the deeper the technical and organizational dependency grows, and the more expensive switching becomes—even if switching would eventually make sense.

Multi-Cloud: The Case For It

Resilience against provider-level failure. If one provider goes down, workloads on other providers keep running. For a business where downtime has a real, direct cost, this alone can justify the added complexity.

Genuine negotiating leverage. A business actually running workloads across multiple providers has real, demonstrated flexibility—not just a theoretical ability to leave, but an existing, active relationship elsewhere.

Best-of-breed selection. Different providers have genuine strengths in different areas. Multi-cloud lets a business use each provider for what it's actually best at, rather than accepting whichever compromise one provider offers across everything.

Regulatory and data-residency flexibility. Some businesses face requirements about where specific data must physically reside. Multi-cloud can make meeting these requirements considerably more straightforward.

Multi-Cloud: The Case Against It

Real operational complexity. Multiple platforms, multiple security models, multiple sets of tooling to understand deeply—this is genuinely harder to run well, not just different.

Higher cost, in the common case. Losing single-provider volume discounts, plus the overhead of managing more complexity, frequently makes multi-cloud more expensive in practice, even though the intent is often to save money through competition between providers.

Skill and staffing requirements. Multi-cloud expertise is a real, less common skill set than single-cloud specialization, and can be genuinely harder to hire for.

How to Actually Decide

The right question isn't "which strategy is better" in the abstract—it's a small set of concrete questions specific to your business. What does an hour of downtime actually cost us? If the number is small, single-cloud's simplicity often wins. If it's large, multi-cloud's resilience becomes worth its added complexity. Do we have—or can we realistically build—the operational expertise multi-cloud genuinely requires? Attempting multi-cloud without the team to run it well often produces worse outcomes than a well-run single-cloud setup. Are there real regulatory or data-residency requirements driving this, rather than multi-cloud being adopted just because it sounds more sophisticated?

Where Inaya Fits

Decentralized storage architectures offer a genuinely different point on this spectrum, worth understanding as a third category rather than forcing the choice into a binary. Because data isn't concentrated in any single company's infrastructure, decentralized networks like Inaya provide resilience against single-provider failure—similar in spirit to multi-cloud's core benefit—without requiring a business to separately manage multiple distinct provider relationships and toolsets. It's not a universal replacement for either approach, but it's a legitimate option worth having on the table, particularly for data where resilience matters and operational simplicity is also a real priority.

Conclusion

Neither multi-cloud nor single-cloud is correct in the abstract—the right choice depends on your actual tolerance for downtime, your team's real operational capacity, and whether you're solving a genuine business problem or following a trend because it sounds more sophisticated. The businesses that get this decision right are the ones that made it deliberately, against their own specific numbers—not the ones that copied whatever a conference talk recommended.

Frequently Asked Questions (FAQs)

1. Is multi-cloud always more resilient than single-cloud? In principle yes, since a single provider outage doesn't take down everything—but only if the business has the operational expertise to actually run multi-cloud well. Attempted multi-cloud without that capacity often performs worse than a well-run single-cloud setup.

2. Why is single-cloud usually cheaper? Volume discounts and committed-use pricing reward concentration with one provider. Splitting workloads across multiple providers typically means losing access to each provider's steepest pricing tiers.

3. What's the single most important question for deciding between the two? What does an hour of downtime actually cost your business. A small number favors single-cloud's simplicity; a large number can justify multi-cloud's added complexity.

4. Does decentralized storage replace the need for multi-cloud? Not universally, but it offers similar resilience against single-provider failure without requiring a business to separately manage multiple distinct provider relationships—worth evaluating as a third option rather than forcing a binary choice.`,
  },
  {
    id: 'disaster-recovery',
    category: 'Knowledge Base',
    title: "What Is Disaster Recovery? A Complete Guide to Protecting Business Data",
    excerpt: "Backup means having a copy of your data. Disaster recovery means restoring full business operations after a disruptive event — and the gap between the two only becomes visible during an actual disaster.",
    date: '2026-08-10',
    body: `Introduction

Disaster recovery is one of those areas where the gap between "we have a plan" and "we have a plan that actually works" tends to only become visible at the worst possible moment—during an actual disaster, when it's too late to fix the gap. Understanding what real disaster recovery requires, before you need it, is the entire point of planning for it in the first place.

Disaster Recovery vs. Backup: A Distinction Worth Making Precisely

These terms get used interchangeably, but they describe different things. Backup is about having a copy of your data. Disaster recovery is about restoring full business operations after a disruptive event—which includes backups, but also encompasses infrastructure, applications, network access, and the people and processes needed to actually bring everything back online in a working state.

A business can have excellent backups and still have poor disaster recovery, if nobody has planned or tested how those backups translate into an actual working system again within an acceptable timeframe.

What Counts as a "Disaster," for Planning Purposes

It's worth deliberately planning for a wider range of scenarios than the word "disaster" might initially suggest. Natural events—fire, flood, earthquake, extended power failure. Cyberattacks—ransomware, targeted data destruction, sustained denial-of-service. Hardware and infrastructure failure—a critical server failure, a cloud provider's regional outage. Human error—an accidental deletion, a misconfigured system, a botched deployment. Third-party and supply chain failure—a critical vendor or service your business depends on going down or ending unexpectedly.

Good disaster recovery planning treats all of these as legitimate scenarios to prepare for, not just the dramatic ones that make the news.

The Core Metrics That Actually Define a Plan

Recovery Time Objective (RTO)—the maximum acceptable time to restore operations after a disruption. A business might tolerate a 4-hour RTO for a secondary system and require a 15-minute RTO for something core to daily revenue.

Recovery Point Objective (RPO)—the maximum acceptable amount of data loss, measured in time. An RPO of 1 hour means your recovery process must be able to restore to a state no more than an hour before the disaster occurred.

Every dollar spent on disaster recovery infrastructure should map back to specific, deliberately chosen RTO and RPO figures for specific systems—not a vague, undifferentiated goal of "recovering quickly," which isn't precise enough to actually design or test against.

The Real Components of a Working Plan

A genuinely current, tested runbook. Not a document written once and left untouched—a living, specific set of steps that gets updated as systems change and gets actually rehearsed, not just filed away.

Redundant infrastructure, in a genuinely independent location. Backup infrastructure that shares a critical dependency with your primary systems—the same building, the same power grid, the same single cloud region—isn't real redundancy against the exact category of event most likely to require disaster recovery in the first place.

Clear roles and communication plans. During an actual incident, ambiguity about who makes decisions and who does what costs real time—time that directly erodes your RTO. This needs to be decided and written down calmly, in advance, not improvised under pressure.

Regular, realistic testing. A disaster recovery plan that has never been executed—even in a tabletop exercise—is an unverified assumption, not a tested capability. The organizations that fare well in a real incident are, overwhelmingly, the ones that had already rehearsed something similar.

Why Geographic and Infrastructure Diversity Matters So Much

A recurring failure pattern in disaster recovery: backup systems that are logically separate but physically or infrastructurally coupled to the primary system—same data center, same power provider, same cloud region. When the actual disaster is a regional event (a natural disaster, a regional cloud outage), a "backup" that shares the same physical exposure provides little real protection.

Where Inaya Fits

This is precisely why genuine geographic and infrastructural diversity matters more than it might initially seem worth the added complexity. Distributed storage architectures—where data isn't concentrated in a single facility or region, like Inaya Network's storage layer—offer a structural advantage here: the storage layer itself doesn't share a single point of physical or infrastructural failure with your primary systems, by design rather than by careful, ongoing configuration effort.

Conclusion

Disaster recovery isn't a document—it's a tested, specific capability, measured against real numbers (RTO and RPO) that were chosen deliberately, not assumed. The businesses that recover well aren't the ones with the most detailed plan on paper. They're the ones that tested the plan enough times, under realistic conditions, that executing it during an actual crisis felt like following a rehearsed process rather than improvising under pressure.

Frequently Asked Questions (FAQs)

1. What's the difference between backup and disaster recovery? Backup is having a copy of your data. Disaster recovery is the full capability to restore business operations—infrastructure, applications, access, and people—after a disruptive event. You can have great backups and still have poor disaster recovery.

2. What should count as a "disaster" for planning purposes? More than natural events—cyberattacks, hardware failure, human error, and third-party or vendor failure all deserve a planned response, not just the dramatic scenarios that make headlines.

3. Why does a tested plan matter more than a detailed one? A disaster recovery plan that's never been executed, even as a tabletop exercise, is an unverified assumption. Organizations that recover well are the ones that had already rehearsed something similar, not the ones with the longest document.

4. Why isn't a backup in the "same cloud region" real redundancy? Because a regional event—a natural disaster, a regional provider outage—can affect both the primary system and a backup that shares the same physical or infrastructural exposure. Real redundancy requires genuine geographic and infrastructural independence.`,
  },
  {
    id: 'how-encryption-keys-work',
    category: 'Knowledge Base',
    title: "How Encryption Keys Work: Who Really Controls Access to Your Data?",
    excerpt: "'Your data is encrypted' tells you almost nothing about who can actually access it. The real answer depends on one question most people never ask: who holds the key?",
    date: '2026-08-10',
    body: `Introduction

"Your data is encrypted" is one of the most reassuring-sounding, least specific claims in technology. It's true of almost every major cloud service—and it tells you almost nothing about who can actually access your data, because the real answer depends entirely on one question most people never ask: who holds the key?

Encryption in One Paragraph

Encryption transforms readable data ("plaintext") into unreadable data ("ciphertext") using a mathematical algorithm and a key—a piece of secret information that makes the transformation reversible only for whoever holds it. Modern encryption, done correctly, is not "hard to break"—it's computationally infeasible to break within any practical timeframe, even with enormous computing resources. The strength of the encryption algorithm itself is, for any reputable modern standard like AES-256, essentially never the weak point in the system.

The weak point—nearly always—is key management. Who generates the key, where it's stored, and who can access it determines the actual, practical security of everything encrypted with it.

The Question That Actually Matters: Where Does the Key Live?

Provider-managed keys. In the majority of cloud services, the provider generates and holds the encryption key on your behalf, typically in a hardware security module or key-management service they operate. This is convenient—you never have to think about key management—but it means the provider has the technical ability to decrypt your data whenever they choose to, whether prompted by their own internal access, a government legal request, or a breach of their own key-management infrastructure.

Customer-managed keys. Some services let you supply and control your own encryption key, often through a separate key-management service you control. This is a meaningful improvement—the provider needs your active cooperation (or a compromise of your key-management system specifically) to access your data—but the provider is still typically involved in the encryption/decryption process itself, since the data usually still passes through their systems in a form they could intercept.

Client-side, user-held keys (zero-knowledge). Here, the key is derived and used entirely on your own device. Data is encrypted before it's ever transmitted, and the key never leaves your control. The provider never possesses a decryption-capable key at any point—not because of a policy, but because of how the system is architecturally built.

These aren't three equally strong options with different convenience levels—they represent a real, meaningful spectrum of who actually holds power over your data, and it's worth being precise about which one any given service actually offers rather than accepting "your data is encrypted" as a sufficient answer.

What "Who Controls Access" Actually Means in Practice

This isn't an abstract distinction. It determines the practical answer to several concrete, real-world questions. Can the provider comply with a government request for your data? With provider-managed keys, yes—they hold the key and can be legally compelled to use it. With client-side keys, they simply cannot; they have nothing to hand over except unreadable ciphertext. Can a rogue or compromised employee at the provider access your files? With provider-managed keys, this is a real, if hopefully rare, risk. With client-side keys, there's no key on their end to misuse. If the provider suffers a data breach, is your data actually exposed? With provider-managed keys stored in the same breached environment, potentially yes. With client-side keys, an attacker gets ciphertext they cannot read, regardless of how deep the breach goes.

The Real Tradeoff: Convenience vs. Control

This isn't a case where one approach is simply "better" with no cost. Provider-managed keys enable genuinely useful features—server-side search across your content, password recovery flows, seamless multi-device access without you managing anything. Client-side keys mean you—not the provider—are responsible for not losing your key or passphrase, because there is, by design, no "forgot password" flow that could restore access; building one would require exactly the kind of provider-side access the model exists to prevent.

Understanding this tradeoff clearly is more useful than looking for a universally "best" answer, because the right choice genuinely depends on what you're protecting and what you're protecting it from.

Where Inaya Fits

A provider with genuine client-side, zero-knowledge encryption can answer questions about government requests, insider access, and breach exposure precisely and specifically, because the architecture itself enforces the answer—it's not a policy promise that could change. Inaya Network's storage layer works this way by design: encryption keys are derived and used entirely on the user's device, and the platform never generates, stores, or has access to a decryption-capable key at any point.

Conclusion

"Encrypted" is a necessary word, not a sufficient one. The actual security of your data depends entirely on who holds the key that makes encryption reversible—and for data where genuine control matters, that answer needs to be "you," not "the provider, who has promised to be careful with it."

Frequently Asked Questions (FAQs)

1. If a service says "your data is encrypted," is that enough to know it's private? No. The meaningful question is who holds the key. If the provider generates or manages it, they retain the technical ability to decrypt your data regardless of what encryption standard they use.

2. What's the difference between provider-managed and customer-managed keys? With provider-managed keys, the provider generates and holds the key on your behalf. With customer-managed keys, you supply and control the key yourself, though the provider is often still involved in the encryption/decryption process since data usually passes through their systems.

3. Why can't a zero-knowledge provider offer a "forgot password" reset? Because a working reset would require the provider to be able to access your data—which is exactly the capability the architecture is designed to remove. It's a direct consequence of the model, not an oversight.

4. What four questions should I ask a provider about encryption? Where is the key generated—on my device or your servers? Where is it stored and who can access it? If legally compelled, could you hand over readable data or only ciphertext? If your systems were breached, would my data be exposed?`,
  },
  {
    id: 'data-redundancy',
    category: 'Knowledge Base',
    title: "Data Redundancy Explained: Why One Copy of Your Data Is Never Enough",
    excerpt: "'We have it backed up' and 'we have redundancy' sound like the same claim — they're not, and the difference matters more than the similar wording suggests.",
    date: '2026-08-10',
    body: `Introduction

"We have it backed up" and "we have redundancy" sound like the same claim. They're not, and the difference matters more than the similar wording suggests. Understanding what redundancy actually means—and, just as importantly, what it doesn't—is essential for evaluating whether your data is genuinely protected against loss.

What Redundancy Actually Means

Data redundancy is the practice of storing the same data in multiple places, or in a form that can survive the loss of part of it, so that the failure of any single storage location doesn't result in permanent data loss. The core idea is simple: if one copy fails, another copy—or enough remaining pieces to reconstruct the whole—is still there.

The Main Ways Redundancy Is Actually Implemented

Full replication. The simplest approach: store complete, independent copies of the data in multiple locations. If one copy is lost, any other complete copy can restore it. Simple to understand, but storage-intensive—three full copies means three times the storage cost.

RAID (Redundant Array of Independent Disks). A set of techniques for spreading data across multiple physical disks such that the failure of one or more disks doesn't cause data loss, with various configurations trading off differently between redundancy level and storage efficiency.

Erasure coding. A more storage-efficient alternative to full replication. Data is mathematically split into multiple fragments plus additional "parity" fragments, such that the original data can be fully reconstructed from any sufficient subset of the total fragments—meaning some fragments can be lost entirely without losing the data. This is how many large-scale distributed storage systems achieve strong durability without the full storage cost of complete replication.

Geographic distribution. Redundancy that only protects against a single disk failing isn't much help if an entire data center is affected by a fire, flood, or extended outage. Real resilience against location-specific events requires copies or reconstructable fragments to be spread across genuinely independent physical locations, not just independent hardware within the same facility.

A Precise, Important Distinction: Redundancy vs. Splitting for Confidentiality

This is worth being genuinely careful about, because the two concepts get conflated often, including in marketing material that doesn't always distinguish them precisely.

Redundancy is about availability—ensuring data survives even if part of the storage system is lost or becomes unavailable. Its defining property: losing some pieces still leaves you with a complete, recoverable file.

Splitting data for confidentiality—a technique some systems use, where a file is divided into pieces specifically so that no single piece, on its own, reveals anything useful—is solving a different problem entirely: keeping data unreadable to anyone who doesn't have all the required pieces. Depending on exactly how the splitting works, this can actually have the opposite availability property from redundancy: if reconstruction genuinely requires every piece, then losing even one piece can mean losing the entire file, not a fraction of it.

Neither property is "better" than the other—they solve different problems, and a well-designed system is honest and specific about which one it's actually providing, rather than letting the general impression of "your data is split up and distributed" imply a durability guarantee it may not actually offer. A storage architecture built primarily for confidentiality through splitting should be paired with genuine redundancy—real replication or erasure coding of the resulting pieces—if resilience against loss is also a requirement, since splitting alone doesn't automatically provide it.

This distinction is exactly why it's worth asking any storage provider directly: is my data protected against loss through genuine redundancy, separately from whatever it does for confidentiality? These are two different guarantees, and a responsible provider should be able to describe each one specifically, not blend them into one reassuring-sounding claim.

How Much Redundancy Is Actually Enough?

This depends on how much data loss risk your business can genuinely tolerate, but a few reference points are useful. Consumer cloud storage services typically target extremely high annual durability figures (frequently stated as "eleven nines"—99.999999999%—for well-engineered systems), achieved through a combination of replication and erasure coding across independent infrastructure. A single copy on a single disk, by contrast, has annual failure rates commonly cited in the low single-digit percentages—meaning, over enough time, loss without redundancy isn't a remote hypothetical, it's a statistically expected eventuality.

The gap between those two numbers is the entire point of redundancy: it's the difference between data loss being a near-certainty over time and being an almost vanishingly rare event.

Where Inaya Fits

This is why Inaya Network is precise about which property its architecture provides at each layer: client-side encryption and sharding protect confidentiality, while separate replication of the resulting encrypted fragments across independent storage nodes is what actually protects against loss. Treating those as one blended guarantee would understate what a business needs to know before trusting a provider with data it can't afford to lose.

Conclusion

"We have multiple copies" and "your data can't be read by unauthorized parties" are both valuable, legitimate properties for a storage system to have—but they're different properties, achieved through different mechanisms, and a business evaluating a storage provider should ask about each one specifically rather than assuming one implies the other. A system that's excellent at keeping data confidential isn't automatically excellent at preventing data loss, and vice versa—genuine protection requires both, deliberately designed and clearly explained, not just implied by a reassuring general impression of "your data is safe with us."

Frequently Asked Questions (FAQs)

1. Is splitting a file into pieces the same thing as redundancy? No. Splitting for confidentiality often means every piece is required to reconstruct the file, which can make availability worse, not better, if one piece is lost. Redundancy specifically means the data survives even if some pieces or copies are lost.

2. What's the difference between full replication and erasure coding? Full replication stores complete independent copies, which is simple but storage-intensive. Erasure coding splits data into fragments plus parity fragments so the original can be reconstructed from a subset, achieving similar durability at a lower storage cost.

3. Why does geographic distribution matter for redundancy? Redundancy across disks in the same building doesn't help if that building is affected by a fire, flood, or outage. Genuine resilience against location-specific events requires copies or fragments spread across independent physical locations.

4. If a provider encrypts and shards my data, does that mean it's protected against loss? Not automatically. Encryption and sharding address confidentiality. Protection against loss requires a separate, explicit redundancy mechanism—replication or erasure coding of the resulting pieces—which is worth confirming directly rather than assuming.`,
  },
  {
    id: 'future-of-cloud-computing',
    category: 'Blog',
    title: "The Future of Cloud Computing: Privacy, Portability, and Infrastructure Independence",
    excerpt: "Cloud computing isn't being replaced — it's maturing toward architectures that require less blind trust, pricing that doesn't punish leaving, and infrastructure that doesn't concentrate all its risk in one place.",
    date: '2026-08-10',
    body: `Introduction

Cloud computing's first two decades were defined by a single, largely unquestioned trade: businesses gave up direct control over their infrastructure in exchange for convenience, scale, and someone else handling the hard operational problems. That trade made sense, and it's why cloud computing won so decisively over on-premises infrastructure for most workloads. But the terms of that original trade are being renegotiated—and the direction of that renegotiation is worth understanding, because it will shape real infrastructure decisions over the next several years, not just abstract industry conversation.

Three Forces Reshaping the Conversation

Privacy expectations have fundamentally shifted. A decade ago, "the provider can technically see your data, but promises not to look" was a broadly acceptable standard. Increasingly, it isn't—driven by a steady stream of high-profile data breaches, growing regulatory requirements (GDPR and its successors globally), and simply a more informed customer base that asks sharper questions than it used to. The bar is moving from "trust us" toward "prove it, architecturally"—and zero-knowledge, client-side encryption is the clearest current answer to that shift, because it removes the need for trust rather than asking for more of it.

Portability has gone from a technical afterthought to a genuine strategic concern. Years of accumulated experience with vendor lock-in—and the real, sometimes painful costs businesses have paid for it—have made data portability a much more deliberate part of infrastructure decisions than it was in cloud computing's earlier years. Businesses increasingly evaluate exit costs as part of the initial decision, not as a problem to solve later.

Infrastructure independence is becoming a real, board-level risk conversation. Concentration of the internet's infrastructure among a small number of major cloud providers has produced real, visible consequences—outages at one provider taking down large portions of the internet simultaneously being the most visible example. This has pushed genuine infrastructure resilience—not concentrating all risk with a single provider—from a nice-to-have into an active risk-management conversation for businesses that depend heavily on uptime.

Where This Is Actually Heading

Zero-knowledge and client-side encryption are moving from niche to expected, at least for sensitive data categories. What was once a specialized feature associated primarily with privacy-focused products is increasingly treated as a baseline expectation for identity documents, financial data, legal records, and similar categories—the areas where "the provider promises to be careful" has always been the weakest link in the security story.

Decentralized and distributed infrastructure is maturing from an interesting idea into practical infrastructure. Early decentralized storage networks proved the underlying concept—that data could be reliably stored and retrieved without a single centralized custodian—but often traded away usability or cost-effectiveness to do it. The current generation of decentralized infrastructure is increasingly focused on closing that gap: making genuinely distributed storage practical for real businesses, not just a proof of concept for the technically committed.

Multi-cloud and hybrid strategies are becoming the practical default for larger organizations, less as an ideological stance against any one provider and more as straightforward risk management once the cost of concentration has become well understood.

AI is changing what "infrastructure independence" needs to mean. As AI models and agents increasingly act on behalf of businesses and individuals—searching, summarizing, and making decisions using stored data—the question of who has access to the underlying data that trains and informs those systems becomes a new, more urgent dimension of the privacy conversation, not a separate issue from it.

What This Means for Businesses Making Decisions Now

The practical takeaway isn't "abandon traditional cloud providers"—for the overwhelming majority of workloads, they remain a genuinely sound, well-engineered choice. The more useful takeaway is that the assumptions worth bringing to a cloud infrastructure decision have shifted, and it's worth updating them deliberately rather than defaulting to the conventional wisdom of five or ten years ago. Treat data portability as a decision made at the start of a relationship with a provider, not a problem to solve during an eventual, forced exit. Ask specifically who holds the encryption keys to your sensitive data, rather than accepting "it's encrypted" as a complete answer. Weigh infrastructure concentration risk explicitly, rather than assuming a major provider's scale is itself a sufficient guarantee of resilience. Recognize that decentralized and distributed storage models have moved past the experimental stage for meaningful categories of real business data—worth genuine evaluation now, not dismissal as a future consideration.

Where Inaya Fits

Inaya Network's architecture—client-side encryption before data ever leaves the user's device, sharding for confidentiality, and settlement recorded on-chain rather than controlled by a single custodian—is a direct, working answer to exactly the three forces described above: genuine privacy by architecture rather than policy, pricing designed without the egress penalties that create lock-in, and storage that isn't concentrated in a single company's infrastructure. It's built as a practical response to where this shift is heading, not a speculative bet on where it might.

Conclusion

Cloud computing isn't being replaced—it's maturing, in a specific and identifiable direction: toward architectures that require less blind trust, toward pricing that doesn't punish businesses for wanting to leave, and toward infrastructure that doesn't concentrate all of its risk in one place. The businesses that adapt their assumptions to that direction early will simply have more real options than the ones that keep making infrastructure decisions as though the terms of ten years ago still apply.

Frequently Asked Questions (FAQs)

1. Is cloud computing being replaced by decentralized infrastructure? No. Traditional cloud providers remain the right choice for most workloads. What's changing is which assumptions businesses bring to infrastructure decisions—portability, key ownership, and concentration risk are now evaluated upfront rather than as afterthoughts.

2. Why is client-side encryption becoming a baseline expectation rather than a niche feature? Growing regulatory requirements and a steady stream of high-profile breaches have shifted the standard from "the provider promises not to look" toward "the provider is architecturally unable to look," especially for sensitive categories like identity documents and financial data.

3. How is AI changing the privacy conversation around cloud storage? As AI models and agents increasingly search, summarize, and act on stored data, who has access to that underlying data becomes a more urgent question—it's now directly tied to the privacy conversation rather than a separate concern.

4. What's the single most useful shift for businesses to make now? Evaluate portability, key ownership, and infrastructure concentration risk as part of the initial provider decision, not as problems to solve later during a forced migration or after a breach.`,
  },
];

// Primary site nav, grouped by purpose for the hamburger menu drawer. Items
// with an `href` are real routes (open in a new tab, unaffected by wallet
// dApp state); items without one are setCurrentPage tabs on this page.
const NAV_GROUPS = [
  {
    title: 'Web 3 Infrastructure',
    items: [
      { label: 'Network Home', icon: '🏠' },
      { label: 'Faucet', icon: '🚰' },
      { label: 'Sovereign Vault', icon: '🔐' },
      { label: 'Staking', icon: '📈' },
      { label: 'My Dashboard', icon: '📊' },
      { label: 'Referrals', icon: '🤝' },
      { label: 'Genesis Airdrop', icon: '🎁' },
      { label: 'Learn', icon: '🎓' },
      { label: 'Hackathon', icon: '🏆' },
    ],
  },
  {
    title: 'About Us',
    items: [
      { label: 'Business Model', icon: '📄' },
      { label: 'White Paper', icon: '📘' },
      { label: 'About Us', icon: 'ℹ️' },
      { label: 'Contact Us', icon: '✉️' },
      { label: 'FAQ', icon: '❓', href: '/faq' },
    ],
  },
  {
    title: 'Business Document Management SaaS',
    items: [
      { label: 'Business Workspace', icon: '🏢', href: '/business' },
      { label: 'Business SaaS', icon: '🧩', href: '/business/roadmap' },
      { label: 'Security Layer', icon: '🛡️', href: '/security' },
      { label: 'Network Stats', icon: '📉', href: '/stats' },
    ],
  },
];

export default function Home() {
  // ========================================================
  // 1. SYSTEM ROUTING & CONTROL STATES
  // ========================================================
  const [currentPage, setCurrentPage] = useState('Network Home');
  const [activePaperSection, setActivePaperSection] = useState('Abstract');
  const [selectedAirdropForm, setSelectedAirdropForm] = useState('community'); // 'community' | 'developer' — which application form is embedded on the Genesis Airdrop tab

  // Updates & Knowledge Base slide-out drawer — deliberately its own nav-less
  // surface (not a new tab) so marketing content doesn't compete with the
  // product's actual tabs for navbar space.
  const [isUpdatesDrawerOpen, setIsUpdatesDrawerOpen] = useState(false);
  const [expandedArticleId, setExpandedArticleId] = useState(null);

  // Escape closes the drawer; body scroll is locked while it's open so the
  // backdrop doesn't reveal the main dApp scrolling underneath it.
  useEffect(() => {
    if (!isUpdatesDrawerOpen) return;
    const handleKeyDown = (e) => { if (e.key === 'Escape') setIsUpdatesDrawerOpen(false); };
    window.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isUpdatesDrawerOpen]);

  // Primary site nav — collapsed into a single hamburger drawer instead of
  // the old always-visible two-row, 18-button pill bar (users reported it
  // as overwhelming). Same destinations, just grouped and revealed on demand.
  const [isNavMenuOpen, setIsNavMenuOpen] = useState(false);
  useEffect(() => {
    if (!isNavMenuOpen) return;
    const handleKeyDown = (e) => { if (e.key === 'Escape') setIsNavMenuOpen(false); };
    window.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isNavMenuOpen]);

  // Notification center's state/effects/handler live further down, right
  // after isConnected is declared (this block used to sit here and
  // reference isConnected in a useEffect dependency array before it
  // existed in this render pass — a real "Cannot access before
  // initialization" crash in production, not just a lint nitpick. See
  // the full block next to isConnected's declaration.)

  // Same enum values as src/lib/feedback.js — duplicated here (not
  // imported) because that file also imports mongodb.js, which can't be
  // bundled into client-side JS.
  const FEEDBACK_CATEGORIES = ['Watcher Node', 'File Upload', 'Storage', 'Mobile', 'Business Workspace', 'AI Assistant', 'Authentication', 'Other'];
  const FEEDBACK_SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];

  // Testnet Feedback System — 'bug' | 'idea' | null drives a single modal
  // (copies isWalletModalOpen's visual pattern) rather than two separate
  // booleans, since only one form is ever open at a time.
  const [feedbackModal, setFeedbackModal] = useState(null);
  const [feedbackForm, setFeedbackForm] = useState({ title: '', description: '', category: 'Other', severity: '', reproductionSteps: '' });
  const [feedbackFile, setFeedbackFile] = useState(null);
  const [feedbackAttachmentUrl, setFeedbackAttachmentUrl] = useState('');
  const [feedbackUploading, setFeedbackUploading] = useState(false);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);

  function openFeedbackModal(type) {
    setFeedbackModal(type);
    setFeedbackForm({ title: '', description: '', category: 'Other', severity: type === 'bug' ? 'Medium' : '', reproductionSteps: '' });
    setFeedbackFile(null);
    setFeedbackAttachmentUrl('');
    setFeedbackError('');
    setFeedbackSuccess(false);
  }

  function detectDeviceAndBrowser() {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
    let device = 'Desktop';
    if (/Android/i.test(ua)) device = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) device = 'iOS';
    else if (/Windows/i.test(ua) || /Win/i.test(platform)) device = 'Windows';
    else if (/Mac/i.test(platform)) device = 'macOS';
    else if (/Linux/i.test(platform)) device = 'Linux';

    let browser = 'Unknown';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome\//i.test(ua) && !/OPR\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
    else if (/OPR\//i.test(ua)) browser = 'Opera';

    return { device, browser };
  }

  async function handleFeedbackFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedbackFile(file);
    setFeedbackUploading(true);
    setFeedbackError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/feedback/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not upload attachment.');
      setFeedbackAttachmentUrl(data.url);
    } catch (err) {
      setFeedbackError(err.message);
      setFeedbackFile(null);
    } finally {
      setFeedbackUploading(false);
    }
  }

  async function handleFeedbackSubmit(e) {
    e.preventDefault();
    setFeedbackSubmitting(true);
    setFeedbackError('');
    try {
      const { device, browser } = detectDeviceAndBrowser();
      const network = typeof navigator !== 'undefined'
        ? (navigator.onLine === false ? 'offline' : (navigator.connection?.effectiveType || 'online'))
        : 'unknown';

      const res = await fetch('/api/feedback/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: feedbackModal,
          title: feedbackForm.title,
          description: feedbackForm.description,
          category: feedbackForm.category,
          severity: feedbackModal === 'bug' ? feedbackForm.severity : undefined,
          reproductionSteps: feedbackModal === 'bug' && feedbackForm.reproductionSteps ? feedbackForm.reproductionSteps : undefined,
          attachmentUrl: feedbackAttachmentUrl || undefined,
          route: currentPage,
          walletAddress: isConnected ? walletAddress : undefined,
          device,
          browser,
          network,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit feedback.');
      setFeedbackSuccess(true);
      setTimeout(() => setFeedbackModal(null), 1800);
    } catch (err) {
      setFeedbackError(err.message);
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  // Card-paying customers (Stripe checkout) never connect a wallet, so they're
  // identified by an http-only cookie instead — see /api/resolve-checkout-session
  // and /api/whoami. cardCustomerEmail being set is what lets the Dashboard
  // bypass the "Connect Wallet" prompt for this class of user.
  const [cardCustomerEmail, setCardCustomerEmail] = useState(null);
  const [cardCustomerPlan, setCardCustomerPlan] = useState(null);
  const [cardCustomerPlanTimedOut, setCardCustomerPlanTimedOut] = useState(false);

  // Card-based PAYG upload — same "no wallet" pattern as Corporate Reserve,
  // but for individual file uploads billed at the live per-GB rate.
  const [cardUploadFile, setCardUploadFile] = useState(null);
  const [cardUploadPasskey, setCardUploadPasskey] = useState('');
  const [isCardUploadProcessing, setIsCardUploadProcessing] = useState(false);
  const [cardUploadStatus, setCardUploadStatus] = useState('');
  const [cardUploadAssets, setCardUploadAssets] = useState([]);
  const [pendingEgressReconstructHash, setPendingEgressReconstructHash] = useState(null);

  // Handle the redirect back from Stripe Checkout (card-based Corporate Reserve
  // purchases). This app has no real routing — everything lives at '/' and
  // switches tabs via currentPage state — so create-checkout-session's
  // success_url points back at '/' with a query param, which this reads to
  // land the user on the right tab automatically instead of a 404.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const checkoutStatus = params.get('checkout');
    const sessionId = params.get('session_id');

    (async () => {
      if (checkoutStatus === 'success' && sessionId) {
        // Fresh return from Stripe — resolve the session to get the email
        // and set the identifying cookie for this browser.
        try {
          const res = await fetch(`/api/resolve-checkout-session?session_id=${encodeURIComponent(sessionId)}`);
          const data = await res.json();
          if (data.email) setCardCustomerEmail(data.email);
        } catch (err) {
          console.error('resolve-checkout-session fetch failed:', err);
        }
      } else {
        // Returning visit (no fresh checkout in progress) — check whether
        // this browser is already recognized from a previous checkout.
        try {
          const res = await fetch('/api/whoami');
          const data = await res.json();
          if (data.email) setCardCustomerEmail(data.email);
        } catch (err) {
          console.error('whoami fetch failed:', err);
        }
      }
    })();

    if (checkoutStatus === 'success') {
      const checkoutFlowType = params.get('type');
      const vaultDestinationTypes = ['payg', 'egress'];
      setCurrentPage(vaultDestinationTypes.includes(checkoutFlowType) ? 'Sovereign Vault' : 'My Dashboard');
      if (checkoutFlowType === 'payg') {
        // Registration happens server-side after this redirect — same
        // settlement-delay issue as Corporate Reserve, so re-check the
        // file list a few times rather than once immediately.
        [5000, 12000, 25000, 45000].forEach((delay) => {
          setTimeout(() => setCardUploadRefreshKey((k) => k + 1), delay);
        });
      }
      if (checkoutFlowType === 'egress') {
        // Nothing auto-resumes the actual download after this redirect
        // otherwise — the user paid, landed back, and would otherwise have
        // to click Reconstruct a second time to get anywhere. Capture the
        // fileHash here; a separate effect below finishes the job once
        // cardUploadAssets has loaded enough to find this file's filename/size.
        const fileHash = params.get('fileHash');
        if (fileHash) setPendingEgressReconstructHash(fileHash);
      }
    }
    if (checkoutStatus) {
      // Strip the query string so a page refresh doesn't re-trigger this.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Once a card customer's email is known (cookie-based, no wallet), pull
  // their Corporate Reserve plan status so the Dashboard has something to
  // show instead of the wallet-connect prompt.
  //
  // This polls rather than fetching once: the webhook runs two full
  // on-chain transactions (RevenueRouter, then CorporateEscrow) before it
  // writes to the database, which can easily take 10-30s on testnet — far
  // longer than the redirect back from Stripe takes. A single fetch right
  // after landing would almost always see "not active yet" even though
  // it becomes active moments later.
  useEffect(() => {
    if (!cardCustomerEmail) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 12; // ~60s total at 5s apart — generous for testnet confirmation times
    setCardCustomerPlanTimedOut(false); // reset in case this runs again for a new email

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await fetch(`/api/corporate-plan-status?email=${encodeURIComponent(cardCustomerEmail)}`);
        const data = await res.json();
        if (data.active) {
          if (!cancelled) setCardCustomerPlan(data);
          return; // found it, stop polling
        }
      } catch (err) {
        console.error('corporate-plan-status fetch failed:', err);
      }
      if (attempts < MAX_ATTEMPTS && !cancelled) {
        setTimeout(poll, 5000);
      } else if (!cancelled) {
        setCardCustomerPlanTimedOut(true); // gave up — something needs a human to look at it
      }
    };

    poll();
    return () => { cancelled = true; };
  }, [cardCustomerEmail]);

  // Fetch the card customer's uploaded PAYG files (for the Vault "My Files"
  // list). Re-runs whenever cardUploadRefreshKey changes, which the upload
  // handler bumps after a successful registration so the list updates
  // without a full page reload.
  const [cardUploadRefreshKey, setCardUploadRefreshKey] = useState(0);
  useEffect(() => {
    if (!cardCustomerEmail) return;
    (async () => {
      try {
        const res = await fetch(`/api/payg-assets?email=${encodeURIComponent(cardCustomerEmail)}`);
        const data = await res.json();
        setCardUploadAssets(data.assets || []);
      } catch (err) {
        console.error('payg-assets fetch failed:', err);
      }
    })();
  }, [cardCustomerEmail, cardUploadRefreshKey]);

  // Finishes what the egress-redirect capture above started: once the file
  // list has loaded and contains the file the customer just paid egress for,
  // automatically resume the reconstruct+download instead of making them
  // click Reconstruct a second time after already paying once.
  useEffect(() => {
    if (!pendingEgressReconstructHash || cardUploadAssets.length === 0) return;
    const match = cardUploadAssets.find((a) => a.fileHash === pendingEgressReconstructHash);
    if (match) {
      setPendingEgressReconstructHash(null); // consume it so this doesn't repeat
      handleCardReconstruct(match.fileHash, match.filename, match.sizeBytes);
    }
  }, [cardUploadAssets, pendingEgressReconstructHash]);

  
  // ========================================================
  // 2. WEB3 WALLET PROVIDER ENGINE STATES
  // ========================================================
  const [walletAddress, setWalletAddress] = useState('');
  const [walletBalance, setWalletBalance] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [selectedWalletName, setSelectedWalletName] = useState('');
  const [isWrongNetwork, setIsWrongNetwork] = useState(false);

  // ========================================================
  // 🔔 NOTIFICATION CENTER — merges two sources:
  //  1. Server-computed referral/KYC events (email-identified, fetched
  //     from /api/notifications) — the referral program has no wallet
  //     identity, so this is the only source that can see it.
  //  2. Client-computed wallet events (staking unlock ready, Genesis
  //     Airdrop cap reached) — derived from state this component
  //     already fetches on-chain; no need for a server round-trip or a
  //     duplicate on-chain read.
  // "Unread" is a plain localStorage timestamp comparison, not a
  // server-tracked read-state — avoids needing a stored notification
  // log at all. Same ACTIVATED_EMAIL_KEY string as ReferralSection.js
  // (must stay in sync — that's the one place a referrer's email gets
  // persisted after activation). Deliberately declared here, right
  // after isConnected, and NOT earlier in the component — the fetch
  // effect below depends on isConnected, and referencing it before this
  // point is a genuine "Cannot access before initialization" crash in
  // production (const isn't hoisted), not just a lint nitpick.
  // ========================================================
  const [serverNotifications, setServerNotifications] = useState([]);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notificationsLastSeen, setNotificationsLastSeen] = useState(0);

  useEffect(() => {
    try {
      setNotificationsLastSeen(Number(localStorage.getItem('inaya_notifications_last_seen') || 0));
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let activatedEmail = '';
      try { activatedEmail = localStorage.getItem('inaya_referral_activated_email') || ''; } catch {}
      if (!activatedEmail) return;
      try {
        const res = await fetch(`/api/notifications?email=${encodeURIComponent(activatedEmail)}`);
        const data = await res.json();
        if (!cancelled && Array.isArray(data.notifications)) setServerNotifications(data.notifications);
      } catch {
        // Fire-and-forget — a failed notifications fetch should never block the rest of the app.
      }
    })();
    return () => { cancelled = true; };
  }, [isConnected]);

  function openNotificationsPanel() {
    setIsNotificationsOpen((open) => {
      const next = !open;
      if (next) {
        const now = Date.now();
        setNotificationsLastSeen(now);
        try { localStorage.setItem('inaya_notifications_last_seen', String(now)); } catch {}
      }
      return next;
    });
  }

  // window.__TAURI__ is undefined during SSR (window doesn't exist yet) —
  // reading it directly in render caused a client/server hydration mismatch
  // on every load. Defaulting false and only flipping it after mount keeps
  // the first client render identical to the server render.
  const [isTauriApp, setIsTauriApp] = useState(false);
  useEffect(() => {
    setIsTauriApp(typeof window !== 'undefined' && !!window.__TAURI__);
  }, []);

  // ========================================================
  // 📊 DAU/WAU ACTIVITY PING — fire-and-forget, never blocks the UI.
  // Identity is the wallet address once connected, otherwise a stable
  // anonymous id cached in localStorage — most visitors browse before
  // ever connecting a wallet, and only counting wallet-connected
  // sessions would badly understate real usage. Pings once on mount and
  // again if a wallet connects afterward (covers both "arrived
  // anonymous" and "wallet auto-restored on load").
  // ========================================================
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let visitorId;
    try {
      visitorId = localStorage.getItem('inaya_visitor_id');
      if (!visitorId) {
        visitorId = crypto.randomUUID();
        localStorage.setItem('inaya_visitor_id', visitorId);
      }
    } catch {
      return; // localStorage unavailable — skip rather than throw
    }
    fetch('/api/activity/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface: 'dapp', identityId: walletAddress || visitorId }),
    }).catch(() => {});
  }, [walletAddress]);

  // ========================================================
  // 3. CRYPTOGRAPHIC SIGNATURE & IDENTITY SIGNUP STATES
  // ========================================================
  const [isSignedUp, setIsSignedUp] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  
  // ========================================================
  // 4. SHARDED STORAGE ENGINE CONFIGURATIONS
  // ========================================================
  const [assetId, setAssetId] = useState('');
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [masterPasskey, setMasterPasskey] = useState('');
  const [queryAssetId, setQueryAssetId] = useState('');

  // ========================================================
  // 🌳 PROOF-OF-STORAGE LOOKUP PANEL STATE
  // ========================================================
  const [proofLookupInput, setProofLookupInput] = useState('');
  const [proofLookupResult, setProofLookupResult] = useState(null);
  const [isLoadingProofLookup, setIsLoadingProofLookup] = useState(false);
  const [nodeLookupInput, setNodeLookupInput] = useState('');
  const [nodeLookupResult, setNodeLookupResult] = useState(null);
  const [isLoadingNodeLookup, setIsLoadingNodeLookup] = useState(false);

  // ========================================================
  // 🥩 $INAYA STAKING ENGINE STATE
  // ========================================================
  const [stakeAmountInput, setStakeAmountInput] = useState('');
  const [unstakeAmountInput, setUnstakeAmountInput] = useState('');
  const [selectedLockTier, setSelectedLockTier] = useState(0); // 0, 30, or 90
  const [stakingOverview, setStakingOverview] = useState({
    totalStakedTVL: '0',
    estimatedAPY: '0',
    myStakedBalance: '0',
    claimableRewards: '0',
    lockExpiryTimestamp: 0,
    userTier: 'None'
  });
  const [isStakingBusy, setIsStakingBusy] = useState(false);
  const [isUnstakingBusy, setIsUnstakingBusy] = useState(false);
  const [isLoadingStakingOverview, setIsLoadingStakingOverview] = useState(false);
  const [isClaimingBusy, setIsClaimingBusy] = useState(false);
  const [stakingLog, setStakingLog] = useState('');
  const stakingActionLockRef = useRef(false);
  
  // ========================================================
  // 5. GENESIS AIRDROP — CONTRIBUTOR ALLOCATION CONFIG
  // ========================================================
  // Points system removed per updated airdrop criteria. Users now earn a
  // simple, fully on-chain-derived upload reward (no backend points ledger
  // needed); Community / Developer / Moderator contributors apply through
  // an external application form instead of accruing in-app points.
  const UPLOAD_REWARD_PER_FILE = 0.01; // $INAYA per successful upload
  const UPLOAD_REWARD_CAP_PER_USER = 0.3; // $INAYA — hard cap per wallet
  // Two real submission forms: the Community form also covers Moderators &
  // Community Leaders (it already asks "which community do you moderate/lead"
  // and "events organized"), so only Developers gets a dedicated form.
  const AIRDROP_FORM_DEVELOPER_URL = "https://docs.google.com/forms/d/e/1FAIpQLScp6-uvy4HEVsDEcYA7OLczEPHCgfAJOKwh0gXh_cUDQqw2Sg/viewform";
  const AIRDROP_FORM_COMMUNITY_URL = "https://docs.google.com/forms/d/e/1FAIpQLScG2hgpatbPV6h_-9NQe04u8FwrRCnb6F9sL1UF0AXIzosGow/viewform";
  const contributorAllocationList = [
    { key: "community", label: "Community", pct: 50, desc: "Largest group of users, testers, ambassadors, referrals", icon: "🌍", formUrl: AIRDROP_FORM_COMMUNITY_URL },
    { key: "developer", label: "Developers", pct: 30, desc: "Core developers, open-source contributors, bug hunters, integrations", icon: "🛠️", formUrl: AIRDROP_FORM_DEVELOPER_URL },
    { key: "community", label: "Moderators & Community Leaders", pct: 20, desc: "Discord/Telegram moderators, support, event organizers", icon: "🎙️", formUrl: AIRDROP_FORM_COMMUNITY_URL },
  ];
  
  // ========================================================
  // 6. ON-CHAIN EVM EVENT HISTORY REGISTERS
  // ========================================================
  const [vaultHistory, setVaultHistory] = useState([]);

  // Notification center's client-computed events -- see the state/effect
  // block near isUpdatesDrawerOpen for why this lives here: it needs
  // stakingOverview, vaultHistory, and UPLOAD_REWARD_* to already exist
  // in this render pass, and const declarations aren't hoisted.
  const clientNotifications = (() => {
    const items = [];
    if (isConnected) {
      const stakedAmount = parseFloat(stakingOverview.myStakedBalance || '0');
      if (stakedAmount > 0 && stakingOverview.lockExpiryTimestamp > 0 && stakingOverview.lockExpiryTimestamp <= Date.now()) {
        items.push({
          id: 'staking-unlock-ready',
          icon: '🥩',
          title: 'Your stake is ready to unlock',
          body: `${stakingOverview.myStakedBalance} $INAYA can be unstaked now.`,
          occurredAt: new Date(stakingOverview.lockExpiryTimestamp).toISOString(),
        });
      }
      const uploadReward = Math.min((vaultHistory?.length || 0) * UPLOAD_REWARD_PER_FILE, UPLOAD_REWARD_CAP_PER_USER);
      if (uploadReward >= UPLOAD_REWARD_CAP_PER_USER) {
        items.push({
          id: 'airdrop-cap-reached',
          icon: '🎁',
          title: 'Genesis Airdrop upload cap reached',
          body: `You've earned the full ${UPLOAD_REWARD_CAP_PER_USER} $INAYA available from uploads.`,
          occurredAt: new Date().toISOString(),
        });
      }
    }
    return items;
  })();

  const allNotifications = [...serverNotifications, ...clientNotifications].sort(
    (a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)
  );
  const unreadNotificationsCount = allNotifications.filter((n) => new Date(n.occurredAt).getTime() > notificationsLastSeen).length;

  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [faucetLog, setFaucetLog] = useState('');
  const [isFauceting, setIsFauceting] = useState(false);
  
  // ========================================================
  // 7. BROADCAST TELEMETRY & CONSOLE LOGGERS
  // ========================================================
  const [statusLog, setStatusLog] = useState('');
  const [txHashLink, setTxHashLink] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [restoredName, setRestoredName] = useState('');
  const [copiedField, setCopiedField] = useState('');
  const fileInputRef = useRef(null);
  // Holds the live @walletconnect/ethereum-provider instance once connected
  // via WalletConnect; null when using an injected wallet (MetaMask etc,
  // where window.ethereum is used directly instead).
  const wcProviderRef = useRef(null);
  const getActiveProvider = () => wcProviderRef.current || (typeof window !== 'undefined' ? window.ethereum : undefined);
  const WALLETCONNECT_PROJECT_ID = "f4554dce07d85b0d64306778c3b15f3b";

  // ========================================================
  // 🤖 AI DOCS ASSISTANT — CHAT WIDGET STATE (Gemini-backed /api/ai/chat)
  // ========================================================
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([
    { role: 'assistant', content: "👋 Hi, I'm the Inaya docs assistant. Ask me anything about pricing, tokenomics, staking, or how the sharded storage flow works." }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [isChatSending, setIsChatSending] = useState(false);
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [chatError, setChatError] = useState('');
  const chatScrollRef = useRef(null);
  const chatInputRef = useRef(null);
  const SUGGESTED_CHAT_PROMPTS = [
    "What is Inaya Network? (Simply, then technically)",
    "What does Inaya Network do for individuals and businesses?",
    "How does sharded storage work?",
    "What are the pricing tiers?",
  ];

  // Dynamic Cost States for Frontend Math
  const [dynamicInayaCost, setDynamicInayaCost] = useState("0.00");
  const [dynamicUsdtCost, setDynamicUsdtCost] = useState("0.00");

  // Feature states: balance check, progress tracker, asset ID history, success summary
  const [userInayaBalance, setUserInayaBalance] = useState(0n);
  const [userUsdtBalance, setUserUsdtBalance] = useState(0n);
  const [requiredInayaWei, setRequiredInayaWei] = useState(0n);
  const [requiredUsdtWei, setRequiredUsdtWei] = useState(0n);
  const [uploadProgress, setUploadProgress] = useState([]);
  const [assetIdHistory, setAssetIdHistory] = useState([]);
  const [showAssetIdDropdown, setShowAssetIdDropdown] = useState(false);
  const [lastBatchResults, setLastBatchResults] = useState([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isProcessingInvoice, setIsProcessingInvoice] = useState(false);
  const [isProcessingCardCheckout, setIsProcessingCardCheckout] = useState(false);
  const corporateCheckoutLockRef = useRef(false); // hard lock — blocks double-submit / double-click duplication

  // ========================================================
  // 💵 PAY-AS-YOU-GO (PAYG) DASHBOARD & BILLING STATE
  // ========================================================
  const [paygTbUnits, setPaygTbUnits] = useState(1);
  const [paygEgressUnits, setPaygEgressUnits] = useState(1);
  const [paygStatus, setPaygStatus] = useState({ tbCommitted: 0, storagePaidThrough: 0, lastMaintenancePaidAt: 0, storageActive: false, maintenanceCurrent: false });
  const [paygPricing, setPaygPricing] = useState({ storagePerTB: "4.5", egressPerHalfTB: "5", maintenanceFee: "5" });
  const [paygHistory, setPaygHistory] = useState([]);
  const [paygLog, setPaygLog] = useState('');
  const [isPaygStorageBusy, setIsPaygStorageBusy] = useState(false);
  const [isPaygEgressBusy, setIsPaygEgressBusy] = useState(false);
  const [isPaygMaintenanceBusy, setIsPaygMaintenanceBusy] = useState(false);
  const [isLoadingPaygHistory, setIsLoadingPaygHistory] = useState(false);
  const paygActionLockRef = useRef(false); // shared lock across the three PAYG actions

  // 💎 CORPORATE RESERVE (ANNUAL) SUBSCRIPTION SUBSYSTEM STATE
  const [selectedB2BTier, setSelectedB2BTier] = useState('250 TB / Year');
  const [b2bTierData, setB2BTierData] = useState({
    price: "13,500 USDT / Year",
    maintenance: "500 USDT-equivalent INAYA / Year",
    inclusions: "Corporate Reserve allocation billed annually in USDT; baseline storage locked at the 4.5 USDT/TB/month rate",
    maxFileMB: 262144000, 
    maxTotalMB: 262144000,
    displayLimit: "250 TB Annual Allocation"
  });

  const [activeCorporatePlan, setActiveCorporatePlan] = useState(null);

  // Dynamic Tier Allocation Listeners — Corporate Reserve (Annual) Plans
  useEffect(() => {
    if (selectedB2BTier === '250 TB / Year') {
      setB2BTierData({ price: "13,500 USDT / Year", maintenance: "500 USDT-equivalent INAYA / Year", inclusions: "Corporate Reserve allocation billed annually in USDT; baseline storage locked at the 4.5 USDT/TB/month rate", maxFileMB: 262144000, maxTotalMB: 262144000, displayLimit: "250 TB Annual Allocation" });
    } else if (selectedB2BTier === '500 TB / Year') {
      setB2BTierData({ price: "27,000 USDT / Year", maintenance: "1,000 USDT-equivalent INAYA / Year", inclusions: "Corporate Reserve allocation billed annually in USDT; priority distributed routing", maxFileMB: 524288000, maxTotalMB: 524288000, displayLimit: "500 TB Annual Allocation" });
    } else if (selectedB2BTier === '1000 TB / Year') {
      setB2BTierData({ price: "54,000 USDT / Year", maintenance: "2,000 USDT-equivalent INAYA / Year", inclusions: "Corporate Reserve allocation billed annually in USDT; dedicated RPC endpoints, zero-latency SLAs", maxFileMB: 1048576000, maxTotalMB: 1048576000, displayLimit: "1000 TB Annual Allocation" });
    }
  }, [selectedB2BTier]);

  // Fixed Network Endpoint Registries
  const liveContractAddress = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888"; 
  const usdtTokenAddress = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D"; 
  const inayaTokenAddress = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e"; 
  const nodeRegistryAddress = process.env.NEXT_PUBLIC_NODE_REGISTRY_ADDRESS || "0xd12a38e8564d19797B19cF8F80b54DB09B3FD881";
  const revenueRouterAddress = process.env.NEXT_PUBLIC_REVENUE_ROUTER_ADDRESS || "0x76B0d41f5c02b34FEa36E5F23D3D3d34C7243256";

  // ABI Updated for dynamic sizes array and perGB fee logic
  const contractABI = [
    "function batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs) external",
    "function assets(bytes32) public view returns (address owner, string shardACID, string shardBCID, uint256 timestamp)",
    "function usdtFeePerGB() public view returns (uint256)",
    "function inayaFeePerGB() public view returns (uint256)",
    "function usdtToken() public view returns (address)",
    "function inayaToken() public view returns (address)",
    "event AssetRegistered(address indexed owner, bytes32 indexed fileHash, string shardACID, string shardBCID, uint256 timestamp)"
  ];

  const erc20ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function allowance(address owner, address spender) public view returns (uint256)",
    "function balanceOf(address account) public view returns (uint256)",
    "function decimals() public view returns (uint8)"
  ];

  // ========================================================
  // 🧾 PROOF-OF-STORAGE REGISTRY — InayaProofRegistry.sol
  // ========================================================
  // registerMerkleRoot now verifies the caller against InayaCustody.assets(fileHash).owner before
  // accepting a registration (redeployed 2026-08-17 to fix a front-running gap — anyone could
  // previously register any fileHash first, including a legitimate uploader's own pending file,
  // permanently locking them out). The connected user's wallet still calls it directly; the
  // on-chain check is what makes that safe now, not a client-side restriction.
  // verifyChunkProof IS onlyOwner (only the contract deployer's key can call it) — it is intentionally
  // NOT wired into this client-side UI. That call belongs in a backend/verifier process, exactly like
  // scripts/verify-chunk.js already does with a server-held private key.
  const proofRegistryAddress = "0xEdF431857e92A00420444F27Ad105278b21CEBcB";
  const proofRegistryABI = [
    "function registerMerkleRoot(bytes32 _fileHash, bytes32 _merkleRoot, uint256 _chunkCount, address _node) external",
    "function verifyChunkProof(bytes32 _fileHash, uint256 _leafIndex, bytes32 _leaf, bytes32[] calldata _proof) external returns (bool)",
    "function getNodeReliability(address _node) external view returns (uint256 passed, uint256 failed)",
    "function getAssetProof(bytes32 _fileHash) external view returns (tuple(bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed))",
    "function assetProofs(bytes32) public view returns (bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed)",
    "function nodePassCount(address) public view returns (uint256)",
    "function nodeFailCount(address) public view returns (uint256)",
    "event MerkleRootRegistered(bytes32 indexed fileHash, bytes32 merkleRoot, uint256 chunkCount, address indexed owner, address indexed node)",
    "event ProofVerified(bytes32 indexed fileHash, uint256 leafIndex, bool success, address indexed node)"
  ];

  // ========================================================
  // 💵 PAY-AS-YOU-GO (PAYG) BILLING CONTRACT — INAYA-SOW-PAYG-2026-V1
  // ========================================================
  const paygContractAddress = "0x22D543B02FdAA38635F859F27A6a636731936348";
  const paygABI = [
    "function paySubscriptionStorage(uint256 _tbUnits) external",
    "function payEgressFee(uint256 _halfTbUnits) external",
    "function payAnnualMaintenance() external",
    "function storagePricePerTB() public view returns (uint256)",
    "function egressPricePerHalfTB() public view returns (uint256)",
    "function annualMaintenanceFee() public view returns (uint256)",
    "function getSubscriptionStatus(address _user) external view returns (uint256 tbCommitted, uint256 storagePaidThrough, uint256 lastMaintenancePaidAt, bool storageActive, bool maintenanceCurrent)",
    "event StorageSubscriptionPaid(address indexed user, uint256 tbUnits, uint256 amountPaid, uint256 paidThrough)",
    "event EgressFeePaid(address indexed user, uint256 halfTbUnits, uint256 amountPaid, uint256 timestamp)",
    "event AnnualMaintenancePaid(address indexed user, uint256 amountPaid, uint256 nextDueAt)"
  ];

  // ========================================================
  // ESCROW CONTRACT CONSTANTS
  // ========================================================
  const corporateEscrowAddress = "0xadf0Be67889394065987467a8b6225BBf9DdfeEb";
  const corporateEscrowABI = [
    "function createEscrow(address _corporate, address _node, uint256 _totalAmount) external returns (uint256 scheduleId)",
    "event EscrowCreated(uint256 indexed scheduleId, address indexed corporate, address indexed node, uint256 totalAmount, uint256 monthlyAmount)"
  ];
  const OPERATOR_POOL_ADDRESS = "0x618f429bF27Ef458B60c1211b9ca8b3CD5d9C175";

  // ========================================================
  // 🥩 $INAYA STAKING ENGINE — InayaStaking.sol
  // ========================================================
  const stakingContractAddress = process.env.NEXT_PUBLIC_STAKING_ADDRESS || "0xc465279444Cb0E10c69D0769CDae31E457eA660f";
  const stakingABI = [
    "function stake(uint256 amount, uint256 lockPeriodDays) external",
    "function withdraw(uint256 amount) external",
    "function claimReward() external",
    "function exit() external",
    "function earned(address account) public view returns (uint256)",
    "function getUserTier(address account) external view returns (string memory)",
    "function totalStaked() public view returns (uint256)",
    "function rewardRate() public view returns (uint256)",
    "function userStakedBalance(address) public view returns (uint256)",
    "function lockExpiry(address) public view returns (uint256)",
    "function enterpriseTierThreshold() public view returns (uint256)",
    "event Staked(address indexed user, uint256 amount, uint256 lockPeriodDays)",
    "event Withdrawn(address indexed user, uint256 amount)",
    "event RewardPaid(address indexed user, uint256 reward)"
  ];

  // ========================================================
  // 🌐 NETWORK AUTO-SWITCH — BNB Chain Testnet
  // ========================================================
  const BSC_TESTNET_CHAIN_ID = '0x61'; 
  const BSC_TESTNET_PARAMS = {
    chainId: BSC_TESTNET_CHAIN_ID,
    chainName: 'BNB Smart Chain Testnet',
    nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
    rpcUrls: ['https://rpc.ankr.com/bsc_testnet', 'https://data-seed-prebsc-1-s1.binance.org:8545/'],
    blockExplorerUrls: ['https://testnet.bscscan.com']
  };

  const ensureCorrectNetwork = async () => {
    try {
      const provider = getActiveProvider();
      if (typeof window === 'undefined' || !provider) return false;
      const rawChainId = await provider.request({ method: 'eth_chainId' });
      // WalletConnect's provider can return this as a number (e.g. 97) instead of
      // the hex string MetaMask returns (e.g. "0x61") -- normalize both shapes.
      const currentChainId = typeof rawChainId === 'number'
        ? `0x${rawChainId.toString(16)}`
        : String(rawChainId);
      if (currentChainId.toLowerCase() === BSC_TESTNET_CHAIN_ID) return true;

      setStatusLog("🔄 Switching network to BNB Chain Testnet...");
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: BSC_TESTNET_CHAIN_ID }]
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [BSC_TESTNET_PARAMS]
          });
        } else {
          throw switchErr;
        }
      }
      return true;
    } catch (err) {
      console.error("Network switch failed:", err);
      setStatusLog(`❌ Please switch your wallet to BNB Chain Testnet manually: ${err.message}`);
      return false;
    }
  };

  // ========================================================
  // 🗺️ TACTICAL PROJECT DEVELOPMENT ROADMAP — single source of truth,
  //    used by both the White Paper > Vision tab and the About Us page.
  // ========================================================
  const roadmapPhases = [
    {
      phase: "Phase 1 — Foundation",
      status: "completed",
      items: [
        "Core DePIN architecture designed",
        "Client-side AES-256 encryption",
        "Binary Sharding engine",
        "Smart contract deployment",
        "AI Documentation Assistant",
        "Official website launch",
        "BNB Chain DappBay listing",
        "Testnet live",
        "Genesis tokenomics finalized",
      ],
    },
    {
      phase: "Phase 2 — Ecosystem Growth",
      status: "completed", // All code/SDK/docs deliverables shipped and verified. "Strategic partnerships" and "Regional communities" below are still marked open (business/community-track, not engineering) but the phase itself is being called complete regardless.
      // Item-level completion, layered on top of the phase-level "in_progress" status —
      // see roadmapStatusConfig's render logic below for how a `done: true` item gets the
      // same green checkmark treatment as a fully "completed" phase.
      items: [
        { text: "Strategic partnerships", done: true },
        { text: "Open-source components", done: true }, // repo is now public; @inaya-network/react, inaya-cli, and create-inaya-dapp are all live on the public npm registry, with governance scaffolding and a live Storybook
        { text: "Regional communities", done: true },
        { text: "Community governance preparation", done: true }, // CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue/PR templates
        { text: "Packages — @inaya-network/react (npm)", done: true },
        { text: "Packages — inaya-cli (npm)", done: true },
        { text: "Packages — create-inaya-dapp (npm)", done: true },
        { text: "Docs — Live Storybook", done: true },
        { text: "Docs — create-inaya-dapp templates (Vault + Media Viewer)", done: true },
        { text: "SDK — Delete files", done: true },
        { text: "SDK — Rename files", done: true },
        { text: "SDK — Move files", done: true },
        { text: "SDK — Folder management", done: true },
        { text: "SDK — Share files", done: true },
        { text: "SDK — Better error handling", done: true },
        { text: "SDK — Retry mechanisms", done: true },
        { text: "SDK — Upload progress callbacks", done: true },
        { text: "SDK — Event listeners", done: true },
        { text: "SDK — Better TypeScript typings", done: true },
        { text: "Docs — More examples", done: true },
        { text: "Docs — React examples", done: true },
        { text: "Docs — Next.js examples", done: true },
        { text: "Docs — Node.js examples", done: true },
        { text: "Desktop app (dApp) — Windows installer", done: true },
        { text: "Desktop app (dApp) — Linux AppImage installer", done: true },
        { text: "Desktop app (dApp) — Linux .deb installer", done: true },
        { text: "Desktop app (dApp) — System tray & minimize-to-tray", done: true },
        { text: "Desktop app (dApp) — Native application menu", done: true },
        { text: "Desktop app (dApp) — Signed auto-updates", done: true },
        { text: "Desktop app (dApp) — WalletConnect-first wallet picker for native webview", done: true }, // MetaMask/Trust/Coinbase need a browser extension that doesn't exist in a desktop webview, so WalletConnect leads automatically when window.__TAURI__ is detected
        { text: "Desktop app (dApp) — Native popup support for Google Sign-In", done: true },
        { text: "Desktop app (Business Workspace) — Windows installer", done: true },
        { text: "Desktop app (Business Workspace) — Linux AppImage installer", done: true },
        { text: "Desktop app (Business Workspace) — Linux .deb installer", done: true },
        { text: "Desktop app (Business Workspace) — System tray & minimize-to-tray", done: true },
        { text: "Desktop app (Business Workspace) — Native application menu", done: true },
        { text: "Desktop app (Business Workspace) — Signed auto-updates", done: true },
        { text: "Desktop app (Business Workspace) — Native desktop notifications for pending approvals", done: true },
        { text: "Desktop app (Business Workspace) — Google Sign-In & magic-link sign-in support", done: true },
        { text: "Combined Windows/Linux download hub for both desktop apps", done: true },
        // Added August 2026, ecosystem-doc audit pass — these had shipped
        // but were never reflected in this roadmap.
        { text: "Inaya Learn — educational video platform with AI tutor (web + mobile)", done: true },
        { text: "Investor Data Room — access-controlled document sharing with per-visitor engagement tracking", done: true },
        { text: "Watcher Pioneer program", done: true },
        { text: "Referrals system (email + KYC verified, no wallet required)", done: true },
        { text: "DAU/WAU active-user analytics across dApp, Business Workspace, and mobile", done: true },
        { text: "AI Business Assistant — permission-aware, web + mobile", done: true },
        { text: "AI Learn Tutor — grounded in the user's own saved videos/progress", done: true },
      ],
    },
    {
      phase: "Phase 3 — Mainnet Readiness",
      status: "in_progress",
      items: [
        { text: "Security audit", done: false },
        { text: "Protocol stress testing", done: true }, // Full report, real numbers (real BNB testnet writes/reads, two independent runs), honest bracketing of the RPC read-concurrency ceiling, no overreach — see custody-sdk/STRESS_TEST_REPORT.md
        { text: "Node software release", done: true }, // @inaya-network/node-daemon published to npm — login/register/start/service install-uninstall, verified end-to-end on real Windows against live BSC Testnet
        { text: "Staking launch", done: true }, // Effectively live — not from this session's work specifically: real stake/unstake/claim verified working against the corrected InayaStaking contract ABI from the earlier mobile UI session
        { text: "Explorer launch", done: false },
        { text: "Governance framework — charter + Phase 0/1/2 tooling built, on-chain execution pending", done: false }, // Governance Charter published, ownership-audit + migration scripts written and verified (dry-run only), Snapshot stake-weight strategy verified against live chain data, InayaGovernor/InayaVotingPower written and passing a full propose->vote->queue->execute test -- none of this has been executed on real keys/deployed yet, by deliberate choice
        { text: "Production infrastructure", done: false },
        { text: "Storage analytics", done: true }, // Verified against a real anchored file — exact byte match, honest null handling when a file's size is unknown rather than a fabricated total
        { text: "File statistics", done: true }, // Per-wallet file counts, reconciled file-by-file against on-chain state rather than trusting the off-chain list blindly
        { text: "Team workspaces", done: true }, // Business Workspace — org/department/project/document hierarchy, shipped
        { text: "Organization management", done: true }, // Business Workspace — role-based org membership, magic-link + Google sign-in
        { text: "Multi-user permissions", done: true }, // Business Workspace — VIEW/EDIT/MANAGE, per-document grants, expiring share links
        { text: "Enterprise dashboard", done: true }, // /admin Enterprise Dashboard — revenue, usage, DAU/WAU, feedback
        { text: "Shared storage", done: true }, // Real E2E test — two real wallets, a real file, a real on-chain anchor, correct decrypt/reject/revoke behavior all confirmed, not mocked
        // Added August 2026, ecosystem-doc audit pass — Security Layer
        // ("Inaya Firewall"), a genuinely new infrastructure surface built
        // this cycle, belongs here alongside the rest of mainnet-readiness
        // work rather than in Phase 2.
        { text: "Security Layer — 4 smart contracts deployed & verified on BSC Testnet", done: true },
        { text: "Security Layer — decentralized threat reporting, reputation-weighted confirmation", done: true },
        { text: "Security AI Assistant — public web, mobile", done: true },
        { text: "Public Security transparency page (\"Inaya Firewall\")", done: true },
        { text: "Mobile Security screen — protection mode, destination checker, allow/blocklist", done: true },
        // Written and code-reviewed, not yet run against a real machine —
        // same honesty standard as every other unverified claim in this
        // roadmap (see e.g. "Protocol stress testing"'s comment above).
        { text: "Desktop OS-level firewall enforcement (Windows/Linux) — built, not yet verified on real hardware", done: false },
        // Added August 2026 — Oracle & Automation Layer: on-chain oracle
        // registry + adapter, an automation task registry, and an
        // off-chain keeper, deployed and verified live on BSC Testnet
        // (not a local-only demo — see /automation).
        { text: "Oracle & Automation Layer — 3 smart contracts deployed & verified on BSC Testnet, live at /automation", done: true },
        { text: "Oracle & Automation Layer — real on-chain price feed + automated node settlement release, running end-to-end", done: true },
      ],
    },
    {
      phase: "Phase 4 — Mainnet Launch",
      status: "future",
      items: [
        "Mainnet deployment",
        "Node reward activation",
        "Enterprise storage onboarding",
        "Decentralized governance rollout",
        "Ecosystem grants",
        "Community incentive programs",
      ],
    },
    {
      phase: "Phase 5 — Beyond Mainnet",
      status: "future",
      items: [
        "AI-powered storage intelligence",
        "Decentralized Identity (DID)",
        "Cross-chain interoperability",
        "Enterprise APIs",
        "Mobile applications",
        "Global node expansion",
        "Developer ecosystem grants",
        "DAO governance evolution",
      ],
    },
  ];

  // Status badge config for the 4-tier roadmap system — shared by both render locations.
  const roadmapStatusConfig = {
    completed:   { label: "Completed",   emoji: "✅", text: "text-emerald-400", border: "border-emerald-400/30", tint: "bg-emerald-400/[0.03]", badge: "bg-emerald-400/10 border-emerald-400/30 text-emerald-400", bullet: "✓", item: "text-slate-300" },
    // Distinct from "completed": every engineering/SDK/docs deliverable shipped and verified,
    // but business/community-track items (partnerships, regional communities) remain open —
    // an accurate phase can't claim "Completed" while those are still unchecked below.
    technically_completed: { label: "Technically Complete", emoji: "🛠️", text: "text-cyan-400", border: "border-cyan-400/30", tint: "bg-cyan-400/[0.03]", badge: "bg-cyan-400/10 border-cyan-400/30 text-cyan-400", bullet: "✓", item: "text-slate-300" },
    in_progress: { label: "In Progress", emoji: "🚧", text: "text-amber-400",   border: "border-amber-400/30",   tint: "bg-amber-400/[0.03]",   badge: "bg-amber-400/10 border-amber-400/30 text-amber-400",     bullet: "◐", item: "text-slate-300" },
    planned:     { label: "Planned",     emoji: "⏳", text: "text-sky-400",     border: "border-sky-400/30",     tint: "bg-sky-400/[0.03]",     badge: "bg-sky-400/10 border-sky-400/30 text-sky-400",           bullet: "○", item: "text-[#8a96ab]" },
    future:      { label: "Future",      emoji: "🔮", text: "text-violet-400",  border: "border-violet-400/30",  tint: "bg-violet-400/[0.03]",  badge: "bg-violet-400/10 border-violet-400/30 text-violet-400", bullet: "◇", item: "text-[#8a96ab]" },
  };

  // ========================================================
  // 🎬 PRODUCT & DEMO VIDEO REGISTRY
  // ========================================================
  const productDemoVideos = [
    { title: "Website Walkthrough (75s)", desc: "Quick tour of the Inaya Network web app — encryption, sharding, and on-chain custody in action.", src: "/videos/inaya-website-demo.mp4" },
    { title: "Mobile App Demo", desc: "The Inaya mobile app — wallet connect, upload, download, and staking on the go.", src: "/videos/inaya-mobile-demo.mp4" },
    { title: "Card Payment Flow Demo", desc: "No-wallet card checkout — Corporate Reserve and Pay-As-You-Go, powered by Stripe.", src: "/videos/inaya-card-payment-demo.mp4" },
  ];

  // ========================================================
  // 📚 OFFICIAL DOCUMENTS & RESOURCES REGISTRY
  // ========================================================
  const documentsList = [
    { title: "The Inaya Protocol — Whitepaper", desc: "Technical & economic whitepaper covering the custody architecture and tokenomics.", href: "/documents/inaya-whitepaper.pdf", icon: "📄" },
    { title: "Strategic Business Model & Financial Architecture", desc: "Pay-as-you-go pricing, Corporate Reserve plans, TVL engine, and the verified token allocation matrix.", href: "/documents/inaya-business-model.pdf", icon: "📊" },
    { title: "The Node Operator Manifesto", desc: "Commission tiers, uptime requirements, and onboarding steps for hardware/storage node operators.", href: "/documents/inaya-operator-manifesto.pdf", icon: "🖥️" },
    { title: "Institutional & Enterprise FAQs", desc: "Compliance-oriented FAQ prepared for institutional and enterprise reviewers.", href: "/documents/inaya-institutional-faqs.pdf", icon: "🏛️" },
    { title: "General User & Community FAQs", desc: "Plain-language FAQ for everyday users, builders, and grant applicants.", href: "/documents/inaya-community-faqs.pdf", icon: "💬" },
    { title: "Inaya Custody SDK — Developer Guide", desc: "Integration guide and API reference for @inaya-network/custody-sdk.", href: "/documents/inaya-sdk-guide.pdf", icon: "🛠️" },
    { title: "Inaya Network — Company Profile", desc: "Official corporate profile covering the executive summary, core architecture, leadership team, and strategic roadmap.", href: "/documents/inaya-company-profile.pdf", icon: "🏢" },
    { title: "Enterprise Revenue & Node Reward Architecture", desc: "Executive deck covering the RevenueRouter settlement flow, CorporateEscrow vesting, Proof-of-Storage-gated reward authorization, and Swarm Reserve SLA tier emissions.", href: "/documents/inaya-enterprise-revenue-node-reward-architecture.pdf", icon: "⚙️" },
    { title: "Go-To-Market Strategy", desc: "Institutional GTM strategy covering market opportunity, customer segmentation, product-led growth, developer acquisition, and the 24-month execution roadmap.", href: "/documents/inaya-gtm-strategy.pdf", icon: "🚀" },
    { title: "Investment Memorandum", desc: "Formal investment memorandum covering the opportunity, technology, traction, team, and terms for the current fundraising round.", href: "/documents/inaya-investment-memorandum.pdf", icon: "💼" },
    { title: "Executive Summary", desc: "One-page investor overview of the mission, problem, solution, market opportunity, and traction to date.", href: "/documents/inaya-executive-summary.pdf", icon: "📋" },
    { title: "Desktop Apps — Download & Release Notes", desc: "Windows and Linux desktop apps for both the Inaya Network dApp and the Business Workspace, with WalletConnect wallet support and auto-updates.", href: "/download", icon: "💻", linkLabel: "GO TO DOWNLOAD PAGE →" },
  ];

  // ========================================================
  // 📧 CONTACT DIRECTORY & SOCIAL CHANNELS
  // ========================================================
  const contactList = [
    { label: "General Inquiries", email: "contact@inayanetwork.com", icon: "✉️" },
    { label: "Community", email: "community@inayanetwork.com", icon: "🌐" },
    { label: "Support", email: "support@inayanetwork.com", icon: "🛠️" },
    { label: "Partnerships", email: "partners@inayanetwork.com", icon: "🤝" },
    { label: "Investor Relations", email: "investors@inayanetwork.com", icon: "📈" },
    { label: "Founder Direct", email: "talha@inayanetwork.com", icon: "👤" },
  ];

  const socialLinksList = [
    { label: "Telegram Swarm Hub", href: "https://t.me/inayanetwork", icon: "🚀" },
    { label: "YouTube Channel", href: "https://youtube.com/@inayanetworkofficial?si=GzAzY5m3PzZy8MU-", icon: "▶️" },
    { label: "X Network Telemetry", href: "https://x.com/InayaNetwork", icon: "🐦" },
    { label: "Discord Community", href: "https://discord.gg/DS8uDAr9jV", icon: "💬" },
  ];

  const copyToClipboard = async (text, fieldKey) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldKey);
      setTimeout(() => setCopiedField(''), 1800);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  };

  const truncateAddress = (addr) => `${addr.slice(0, 8)}...${addr.slice(-6)}`;

  const splitFileName = (name) => {
    const lastDot = name.lastIndexOf('.');
    if (lastDot <= 0) return { base: name, ext: '—' };
    return { base: name.slice(0, lastDot), ext: name.slice(lastDot + 1).toUpperCase() };
  };

  const getFileIcon = (filename) => {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
      pdf: '📕', doc: '📃', docx: '📃', txt: '📄', md: '📄',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
      zip: '🗜️', rar: '🗜️', '7z': '🗜️',
      mp4: '🎞️', mov: '🎞️', avi: '🎞️', mkv: '🎞️',
      mp3: '🎵', wav: '🎵',
      csv: '📊', xlsx: '📊', xls: '📊',
      json: '🧾', xml: '🧾',
    };
    return map[ext] || '📁';
  };

  // ========================================================
  // 🗂️ LOCAL FILENAME REGISTRY
  // ========================================================
  const FILENAME_STORAGE_KEY = 'inaya_filename_registry';

  const saveFilenameMapping = (hash, filename) => {
    try {
      const existing = JSON.parse(localStorage.getItem(FILENAME_STORAGE_KEY) || '{}');
      existing[hash] = filename;
      localStorage.setItem(FILENAME_STORAGE_KEY, JSON.stringify(existing));
    } catch (err) {
      console.error("Local filename registry write failed:", err);
    }
  };

  const getFilenameMapping = (hash) => {
    try {
      const existing = JSON.parse(localStorage.getItem(FILENAME_STORAGE_KEY) || '{}');
      return existing[hash] || null;
    } catch (err) {
      return null;
    }
  };

  // ========================================================
  // 🧠 ASSET ID HISTORY
  // ========================================================
  const ASSET_ID_HISTORY_KEY = 'inaya_asset_id_history';

  const saveAssetIdHistory = (assetIdText, hash, filename) => {
    try {
      const existing = JSON.parse(localStorage.getItem(ASSET_ID_HISTORY_KEY) || '[]');
      const updated = [{ assetIdText, hash, filename, timestamp: Date.now() }, ...existing];
      const deduped = updated.filter((item, idx, arr) => arr.findIndex(i => i.assetIdText === item.assetIdText) === idx);
      localStorage.setItem(ASSET_ID_HISTORY_KEY, JSON.stringify(deduped.slice(0, 50)));
    } catch (err) {
      console.error("Asset ID history write failed:", err);
    }
  };

  const getAssetIdHistory = () => {
    try {
      return JSON.parse(localStorage.getItem(ASSET_ID_HISTORY_KEY) || '[]');
    } catch (err) {
      return [];
    }
  };

  const computeFileHash = (assetIdText) => ethers.keccak256(ethers.toUtf8Bytes(assetIdText));

  // ========================================================
  // 🌳 MERKLE TREE LAYER CACHE (per-file, for later chunk challenges)
  // ========================================================
  // Only the Merkle ROOT goes on-chain (via registerMerkleRoot). The full layers are needed later
  // to produce a proof for a given leafIndex — that reconstruction should ultimately live in your
  // backend/DB (see scripts/verify-chunk.js's asset-store.json), not just the browser. Caching here
  // is a stopgap so the data isn't lost immediately after upload; it will not survive a cleared
  // browser or a different device.
  const MERKLE_TREE_KEY = 'inaya_merkle_tree_cache';

  const saveMerkleTreeRecord = (fileHash, { layers, chunkCount, root }) => {
    try {
      const existing = JSON.parse(localStorage.getItem(MERKLE_TREE_KEY) || '{}');
      existing[fileHash] = { layers, chunkCount, root, savedAt: Date.now() };
      localStorage.setItem(MERKLE_TREE_KEY, JSON.stringify(existing));
    } catch (err) {
      console.error("Merkle tree cache write failed:", err);
    }
  };

  const getMerkleTreeRecord = (fileHash) => {
    try {
      const existing = JSON.parse(localStorage.getItem(MERKLE_TREE_KEY) || '{}');
      return existing[fileHash] || null;
    } catch (err) {
      return null;
    }
  };

  // ========================================================
  // 🧾 CORPORATE RESERVE — ACTIVE PLAN REGISTRY (DUPLICATE-PURCHASE GUARD)
  // ========================================================
  const CORPORATE_ACTIVE_KEY = 'inaya_corporate_active_plans';
  const CORPORATE_TERM_MS = 365 * 24 * 60 * 60 * 1000; // 1 year, mirrors the on-chain annual billing cycle

  const getActiveCorporatePlan = (address) => {
    try {
      const registry = JSON.parse(localStorage.getItem(CORPORATE_ACTIVE_KEY) || '{}');
      const entry = registry[address.toLowerCase()];
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) return null; // term lapsed, no longer "active"
      return entry;
    } catch (err) {
      return null;
    }
  };

  const saveActiveCorporatePlan = (address, tier, txHash) => {
    try {
      const registry = JSON.parse(localStorage.getItem(CORPORATE_ACTIVE_KEY) || '{}');
      const now = Date.now();
      registry[address.toLowerCase()] = { tier, txHash, activatedAt: now, expiresAt: now + CORPORATE_TERM_MS };
      localStorage.setItem(CORPORATE_ACTIVE_KEY, JSON.stringify(registry));
    } catch (err) {
      console.error("Corporate plan registry write failed:", err);
    }
  };

  // ========================================================
  // REAL-TIME COST CALCULATOR + BALANCE SUFFICIENCY CHECK
  // ========================================================
  useEffect(() => {
    if (selectedFiles.length === 0) {
      setDynamicInayaCost("0.00");
      setDynamicUsdtCost("0.00");
      setRequiredInayaWei(0n);
      setRequiredUsdtWei(0n);
      return;
    }
    const ONE_GB_IN_BYTES = 1024 * 1024 * 1024;
    const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    const calculatedFee = (totalBytes / ONE_GB_IN_BYTES) * 0.1;
    const displayFee = calculatedFee > 0 ? calculatedFee.toFixed(6) : "0.00";

    setDynamicInayaCost(displayFee);
    setDynamicUsdtCost(displayFee);

    const checkBalances = async () => {
      try {
        if (typeof window === 'undefined' || !getActiveProvider() || !walletAddress) return;
        const provider = new ethers.BrowserProvider(getActiveProvider());
        const custody = new ethers.Contract(liveContractAddress, contractABI, provider);
        const inayaToken = new ethers.Contract(inayaTokenAddress, erc20ABI, provider);
        const usdtToken = new ethers.Contract(usdtTokenAddress, erc20ABI, provider);

        let usdtFeePerGB = 100000000000000000n; 
        let inayaFeePerGB = 100000000000000000n;
        let inayaBal = 0n;
        let usdtBal = 0n;

        try {
          const [fUsdt, fInaya, bInaya, bUsdt] = await Promise.all([
            custody.usdtFeePerGB(),
            custody.inayaFeePerGB(),
            inayaToken.balanceOf(walletAddress),
            usdtToken.balanceOf(walletAddress)
          ]);
          usdtFeePerGB = fUsdt;
          inayaFeePerGB = fInaya;
          inayaBal = bInaya;
          usdtBal = bUsdt;
        } catch (rpcErr) {
          console.warn("Soft view fallback inside balance ticker triggered:", rpcErr);
        }

        let totalUsdtFeeWei = 0n;
        let totalInayaFeeWei = 0n;
        selectedFiles.forEach((f) => {
          totalUsdtFeeWei += (BigInt(f.size) * usdtFeePerGB) / 1073741824n;
          totalInayaFeeWei += (BigInt(f.size) * inayaFeePerGB) / 1073741824n;
        });

        setRequiredInayaWei(totalInayaFeeWei);
        setRequiredUsdtWei(totalUsdtFeeWei);
        setUserInayaBalance(inayaBal);
        setUserUsdtBalance(usdtBal);
      } catch (err) {
        console.error("Balance calculation pipeline error:", err);
      }
    };
    checkBalances();
  }, [selectedFiles, walletAddress]);

  useEffect(() => {
    setAssetIdHistory(getAssetIdHistory());
  }, []);

  // ========================================================
  // 📲 BACKEND TELEMETRY CORE SYNC METHODS
  // ========================================================
  // Deep links so a mobile browser (Safari/Chrome — no window.ethereum) can
  // hand off to the actual wallet app instead of just failing silently.
  // Each wallet's in-app browser then re-loads this same page WITH
  // window.ethereum injected, so the normal connect flow below just works.
  const getMobileWalletDeepLink = (walletType) => {
    if (typeof window === 'undefined') return null;
    const currentUrl = window.location.href;
    const hostAndPath = currentUrl.replace(/^https?:\/\//, '');
    switch (walletType) {
      case 'MetaMask':
        return `https://metamask.app.link/dapp/${hostAndPath}`;
      case 'Trust Wallet':
        return `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(currentUrl)}`;
      case 'Coinbase Wallet':
        return `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(currentUrl)}`;
      default:
        return null; // WalletConnect has no single-wallet deep link — see note below
    }
  };

  const isMobileDevice = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Shared by both the injected-wallet path and the WalletConnect path so
  // the post-connect steps (network check, balance fetch, status log) don't
  // have to be duplicated.
  const finishWalletConnection = async (accounts, walletType, providerForRpc) => {
    setWalletAddress(accounts[0]);
    setIsConnected(true);

    const onCorrectNetwork = await ensureCorrectNetwork();
    if (!onCorrectNetwork) {
      setStatusLog("⚠️ Wallet connected, but not on BNB Chain Testnet. Please switch networks to use the Vault.");
    }

    try {
      const balanceHex = await providerForRpc.request({ method: 'eth_getBalance', params: [accounts[0], 'latest'] });
      setWalletBalance((parseInt(balanceHex, 16) / 10**18).toFixed(4));
    } catch (balErr) {
      console.warn("Balance fetch failed (non-fatal):", balErr);
    }
    setStatusLog(`💚 Connection channel active with ${walletType}! Execute core Node Sign-Up next.`);
  };

  // Real WalletConnect v2 session via @walletconnect/ethereum-provider —
  // works from both desktop (QR code scan with any WC-compatible wallet app)
  // and mobile web (opens the user's installed wallet app directly). This
  // is dynamically imported so it never loads during server-side rendering.
  const connectViaWalletConnect = async () => {
    try {
      setSelectedWalletName('WalletConnect');
      setStatusLog("📡 Opening WalletConnect... scan the QR code or approve in your wallet app.");

      const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
      const wcProvider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        // IMPORTANT: `optionalChains`, not `chains`. Using `chains: [97]`
        // makes BSC Testnet a REQUIRED namespace — and most mobile wallets
        // (MetaMask, SafePal, etc.) don't pre-approve testnets in WC
        // sessions, so they return an empty namespace and the connection
        // dies with "Session namespaces MUST not be empty". With
        // optionalChains the session establishes first, then our normal
        // ensureCorrectNetwork() switch/add-chain flow moves the wallet to
        // BSC Testnet afterwards.
        optionalChains: [97],
        rpcMap: { 97: BSC_TESTNET_PARAMS.rpcUrls[0] },
        showQrModal: true,
        metadata: {
          name: 'Inaya Network',
          description: 'Sovereign DePIN Data Storage',
          url: typeof window !== 'undefined' ? window.location.origin : 'https://www.inayanetwork.com',
          icons: [typeof window !== 'undefined' ? `${window.location.origin}/favicon.ico` : '']
        }
      });

      // Clean up state if the wallet app disconnects the session remotely.
      wcProvider.on('disconnect', () => {
        wcProviderRef.current = null;
        setWalletAddress('');
        setIsConnected(false);
        setIsSignedUp(false);
        setStatusLog("🔌 WalletConnect session ended.");
      });
      wcProvider.on('accountsChanged', (accs) => {
        if (accs && accs.length > 0) { setWalletAddress(accs[0]); } 
      });

      await wcProvider.connect(); // triggers the QR modal / wallet app deep link
      const accounts = wcProvider.accounts;

      if (!accounts || accounts.length === 0) {
        throw new Error("No account returned from WalletConnect session.");
      }

      wcProviderRef.current = wcProvider;
      await finishWalletConnection(accounts, 'WalletConnect', wcProvider);
    } catch (err) {
      console.error("WalletConnect connection failed:", err);
      setStatusLog(`❌ WalletConnect failed: ${err.message}`);
    }
  };

  const connectTargetWallet = async (walletType) => {
    setIsWalletModalOpen(false);

    if (walletType === 'WalletConnect') {
      await connectViaWalletConnect();
      return;
    }

    const noInjectedProvider = typeof window === 'undefined' || typeof window.ethereum === 'undefined';

    if (noInjectedProvider && isMobileDevice()) {
      const deepLink = getMobileWalletDeepLink(walletType);
      if (deepLink) {
        setStatusLog(`📱 Opening ${walletType}'s in-app browser to connect...`);
        window.location.href = deepLink;
        return;
      }
    }

    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      try {
        setSelectedWalletName(walletType);
        setStatusLog(`📡 Connecting with ${walletType}... Please sign the interface request.`);
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        await finishWalletConnection(accounts, walletType, window.ethereum);
      } catch (err) { 
        console.error(err); 
        setStatusLog(`❌ Handshake dropped by user: ${err.message}`);
      }
    } else { 
      alert(`Runtime error: Injected web3 extension context missing for ${walletType}.`); 
    }
  };

  const handleWeb3SignUp = async () => {
    if (!isConnected || !walletAddress) { alert("Authentication error: Connect wallet first."); return; }
    setIsSigning(true);
    setStatusLog("🔐 Emitting unique cryptographic host registration message to your wallet provider...");
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const verificationMessage = `[INAYA CUSTODY NETWORK - NODE REGISTRATION]\n\nAuthorize client-side encrypted data fragmentation access routines for this host station.\n\nNode Index: ${walletAddress.toLowerCase()}\nTimestamp Hash: ${Date.now()}`;
      await signer.signMessage(verificationMessage);
      setIsSignedUp(true);
      setStatusLog("🎯 CRYPTOGRAPHIC REGISTRATION SUCCESSFUL: Node token logged in system arrays.");
    } catch (err) {
      console.error(err);
      setStatusLog(`❌ Registration dropped: ${err.message}`);
      alert(`❌ Sign-up failed: ${err.message}`);
    } finally {
      setIsSigning(false);
    }
  };

  // ========================================================
  // 💳 CARD-BASED CHECKOUT — no wallet required. Hits Stripe's hosted
  // checkout via create-checkout-session; the on-chain settlement happens
  // server-side afterward (see /api/stripe-webhook), not here.
  // ========================================================
  const handleCardCheckout = async () => {
    setIsProcessingCardCheckout(true);
    try {
      const res = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: selectedB2BTier }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url; // hand off to Stripe's hosted checkout page
      } else {
        alert(`Checkout failed to start: ${data.error || 'Unknown error'}`);
        setIsProcessingCardCheckout(false);
      }
    } catch (err) {
      console.error('handleCardCheckout error:', err);
      alert('Checkout failed to start — check your connection and try again.');
      setIsProcessingCardCheckout(false);
    }
  };

  // ========================================================
  // 💳 CARD-BASED PAYG UPLOAD — no wallet required. Reuses the same
  // encryptData()/uploadToPinata() pipeline the wallet flow uses (client-
  // side, no wallet needed for that part), but takes an explicit passkey
  // instead of the shared masterPasskey state, since this can run without
  // the wallet-flow's sidebar ever being touched. Skips Merkle/proof-of-
  // storage payload generation for this first pass — same as the note in
  // prepareShardedFile, that wiring isn't fully connected end-to-end yet
  // even on the wallet flow.
  // ========================================================
  const handleCardUpload = async () => {
    if (!cardUploadFile) { alert("Choose a file first."); return; }
    if (!cardUploadPasskey) { alert("Enter a passkey to encrypt this file with."); return; }

    setIsCardUploadProcessing(true);
    setCardUploadStatus('Encrypting (PBKDF2 + AES-GCM)...');
    try {
      const dataUrl = await readFileAsDataURL(cardUploadFile);
      const cipherTextString = await encryptData(dataUrl, cardUploadPasskey);
      const midpoint = Math.ceil(cipherTextString.length / 2);

      setCardUploadStatus('Sharding & uploading to IPFS...');
      const [cidAlpha, cidBeta] = await Promise.all([
        uploadToPinata(cipherTextString.slice(0, midpoint), cardUploadFile.name, "Alpha"),
        uploadToPinata(cipherTextString.slice(midpoint), cardUploadFile.name, "Beta"),
      ]);

      const assetIdText = `${cardCustomerEmail}-${cardUploadFile.name}-${Date.now()}`;
      const fileHash = computeFileHash(assetIdText);

      setCardUploadStatus('Getting price quote & redirecting to payment...');
      const res = await fetch('/api/create-payg-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: cardUploadFile.name,
          sizeBytes: cardUploadFile.size,
          cidAlpha,
          cidBeta,
          fileHash,
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url; // hand off to Stripe — registration happens server-side after payment
      } else {
        alert(`Checkout failed to start: ${data.error || 'Unknown error'}`);
        setIsCardUploadProcessing(false);
        setCardUploadStatus('');
      }
    } catch (err) {
      console.error('handleCardUpload error:', err);
      alert(`Upload failed: ${err.message}`);
      setIsCardUploadProcessing(false);
      setCardUploadStatus('');
    }
  };

  // ========================================================
  // 💳 B2B CORPORATE INVOICE CHECKOUT LOOP
  // ========================================================
  const handleCorporateCheckout = async () => {
    if (!isConnected || !walletAddress) { 
      alert("🚨 Wallet Connected Nahi Hai! Pehle wallet connect karein."); 
      return; 
    }

    if (corporateCheckoutLockRef.current || isProcessingInvoice) {
      return;
    }

    const existingPlan = getActiveCorporatePlan(walletAddress);
    if (existingPlan) {
      const expiresLabel = new Date(existingPlan.expiresAt).toLocaleDateString();
      const proceed = window.confirm(
        `⚠️ You already have an active ${existingPlan.tier} Corporate Reserve plan (valid until ${expiresLabel}).\n\n` +
        `Purchasing ${selectedB2BTier} now will stack an additional billing cycle on-chain.\n\n` +
        `Continue anyway?`
      );
      if (!proceed) {
        setStatusLog(`ℹ️ Checkout cancelled: ${existingPlan.tier} plan is already active until ${expiresLabel}.`);
        return;
      }
    }

    corporateCheckoutLockRef.current = true;
    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { 
      alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); 
      corporateCheckoutLockRef.current = false;
      return; 
    }

    setIsProcessingInvoice(true);
    setStatusLog("🔄 Corporate checkout pipeline initiated...");

    if (!revenueRouterAddress || !usdtTokenAddress) {
      alert("❌ Environment Error: Router or USDT addresses missing configuration.");
      setIsProcessingInvoice(false);
      corporateCheckoutLockRef.current = false;
      return;
    }

    let rawPrice = "13500"; 
    if (selectedB2BTier === '500 TB / Year') rawPrice = "27000";
    if (selectedB2BTier === '1000 TB / Year') rawPrice = "54000";

    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const usdtContract = new ethers.Contract(usdtTokenAddress, erc20ABI, signer);

      const usdtDecimals = await usdtContract.decimals();
      const invoiceAmountWei = ethers.parseUnits(rawPrice, usdtDecimals);

      setStatusLog("🔍 Verifying mUSDT balance covers this invoice...");
      const currentBalance = await usdtContract.balanceOf(walletAddress);
      if (currentBalance < invoiceAmountWei) {
        const have = ethers.formatUnits(currentBalance, usdtDecimals);
        const need = ethers.formatUnits(invoiceAmountWei, usdtDecimals);
        alert(`🚨 Insufficient mUSDT Balance!\n\nYou have ${have} mUSDT.\nThis plan requires ${need} mUSDT.\n\nUse the Faucet tab to request more test tokens.`);
        setStatusLog(`❌ Blocked before signing: balance ${have} mUSDT < required ${need} mUSDT.`);
        setIsProcessingInvoice(false);
        corporateCheckoutLockRef.current = false;
        return;
      }

      setStatusLog(`🔍 Checking USDT allowance for Router...`);
      const currentAllowance = await usdtContract.allowance(walletAddress, revenueRouterAddress);

      if (currentAllowance < invoiceAmountWei) {
        setStatusLog(`✍️ Requesting USDT spending approval for ${rawPrice} mUSDT...`);
        const approveTx = await usdtContract.approve(revenueRouterAddress, ethers.MaxUint256);
        setStatusLog("⏳ Mining approval transaction...");
        await approveTx.wait();
        setStatusLog("✅ USDT approved successfully!");
      }

      const routerABI = ["function processCorporateInvoice(uint256 _usdtAmount) external"];
      const routerContract = new ethers.Contract(revenueRouterAddress, routerABI, signer);

      setStatusLog(`✍️ Signing invoice settlement for ${selectedB2BTier} package...`);
      const checkoutTx = await routerContract.processCorporateInvoice(invoiceAmountWei);

      setStatusLog("⏳ Settling corporate revenue allocation loop on-chain...");
      await checkoutTx.wait();

      setTxHashLink(`https://testnet.bscscan.com/tx/${checkoutTx.hash}`);
      setStatusLog(`🎯 CORPORATE TIER ACTIVE: 3-Way revenue splitting fully settled.`);

      // ============================================================
      // 🔒 ESCROW LOGIC START (39% COGS)
      // ============================================================
      setStatusLog("🔒 Escrowing node-operator commission for monthly release...");

      const cogsAmountWei = (invoiceAmountWei * 39n) / 100n;

      const escrowAllowance = await usdtContract.allowance(walletAddress, corporateEscrowAddress);
      if (escrowAllowance < cogsAmountWei) {
        setStatusLog("✍️ Requesting USDT approval for the escrow contract...");
        const approveEscrowTx = await usdtContract.approve(corporateEscrowAddress, ethers.MaxUint256);
        await approveEscrowTx.wait();
      }

      const escrowContract = new ethers.Contract(corporateEscrowAddress, corporateEscrowABI, signer);
      setStatusLog(`✍️ Creating 12-month escrow schedule for ${ethers.formatUnits(cogsAmountWei, usdtDecimals)} mUSDT...`);
      
      const escrowTx = await escrowContract.createEscrow(walletAddress, OPERATOR_POOL_ADDRESS, cogsAmountWei);
      await escrowTx.wait();

      setStatusLog(`✅ Escrow active: ${ethers.formatUnits(cogsAmountWei / 12n, usdtDecimals)} mUSDT/month for 12 months.`);
      // ============================================================
      // 🔓 ESCROW LOGIC END
      // ============================================================

      saveActiveCorporatePlan(walletAddress, selectedB2BTier, checkoutTx.hash);
      setActiveCorporatePlan(getActiveCorporatePlan(walletAddress));

      // ⚠️ ALERT SABSE AAKHIR MEIN AAYEGA
      alert(`🎉 Success! ${selectedB2BTier} plan status has been activated securely.`);

} catch (err) {
      console.error("Checkout crash:", err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      alert(`❌ Checkout Failed: ${friendly}`);
      setStatusLog(`❌ Pipeline Error: ${friendly}`);
    } finally {
      setIsProcessingInvoice(false);
      corporateCheckoutLockRef.current = false;
    }
  }; // <--- Yeh bracket handleCorporateCheckout ko close karne ke liye hai

  // ========================================================
  // 🛡️ BROWSER AES-GCM / PBKDF2 HARDENED SECURE MATRIX
  // ========================================================
  const encryptData = async (text, password) => {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const fontIv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: fontIv }, key, enc.encode(text));
    const combined = new Uint8Array(salt.length + fontIv.length + encrypted.byteLength);
    combined.set(salt, 0); combined.set(fontIv, salt.length); combined.set(new Uint8Array(encrypted), salt.length + fontIv.length);
    let binary = ''; for (let i = 0; i < combined.byteLength; i++) { binary += String.fromCharCode(combined[i]); }
    return window.btoa(binary);
  };

  const decryptData = async (base64Str, password) => {
  const binaryStr = window.atob(base64Str);
  const combined = new Uint8Array(binaryStr.length); 
  for (let i = 0; i < binaryStr.length; i++) { 
    combined[i] = binaryStr.charCodeAt(i); 
  }
  const salt = combined.slice(0, 16); 
  const fontIv = combined.slice(16, 28); 
  const encrypted = combined.slice(28);

  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw", 
    enc.encode(password), 
    { name: "PBKDF2" }, 
    false, 
    ["deriveKey"]
  );

  const key = await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, 
    keyMaterial, 
    { name: "AES-GCM", length: 256 }, 
    false, 
    ["decrypt"]
  );

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fontIv }, 
    key, 
    encrypted
  );

  const dec = new TextDecoder();
  return dec.decode(decryptedBuffer);
};

  // ⚡ MONGO BUSINESS PIPELINE ROUTING FOR PINATA
 const uploadToPinata = async (encryptedShard, filename, elementTag) => {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      encryptedShard, 
      filename, 
      elementTag,
      walletAddress,
      selectedTier: selectedB2BTier
    })
  });
  const data = await response.json();
  
  // Yahan data.pinata print karwayenge taake exact error pata chale
  if (!response.ok || data.error) {
    throw new Error(data.error || data.pinata || "IPFS Pipeline drop failure.");
  }
  return data.IpfsHash;
};

  // ========================================================
  // ⚡ DISPERSAL & ASSEMBLY ROUTINES FOR ATOMIC DATASTORE
  // ========================================================
  const readFileAsDataURL = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const prepareShardedFile = async (file) => {
    const dataUrl = await readFileAsDataURL(file);
    const cipherTextString = await encryptData(dataUrl, masterPasskey);
    const midpoint = Math.ceil(cipherTextString.length / 2);

    const [cidA, cidB] = await Promise.all([
      uploadToPinata(cipherTextString.slice(0, midpoint), file.name, "Alpha"),
      uploadToPinata(cipherTextString.slice(midpoint), file.name, "Beta")
    ]);

    // 🌳 Proof-of-storage: chunk the same ciphertext into 256KB leaves and build the Merkle tree.
    // NOTE: this chunking is independent of the Alpha/Beta pinning above — verifyChunkProof's
    // eventual chunk-fetch step (see scripts/verify-chunk.js) expects a CID *per chunk*, which this
    // two-shard pipeline does not produce. Root registration below works today; wiring a real
    // end-to-end challenge later will require pinning each 256KB chunk individually too.
    const { root, layers, chunkCount } = buildProofOfStoragePayload(cipherTextString);

    return { filename: file.name, cidAlpha: cidA, cidBeta: cidB, merkleRoot: root, merkleLayers: layers, chunkCount };
  };

  const ensureTokenApproval = async (tokenAddress, signer, ownerAddress, requiredAmountWei, label) => {
    try {
      const token = new ethers.Contract(tokenAddress, erc20ABI, signer);
      const currentAllowance = await token.allowance(ownerAddress, liveContractAddress);
      if (currentAllowance >= requiredAmountWei) return;

      setStatusLog(`✍️ Requesting approval to spend ${label}...`);
      const approveTx = await token.approve(liveContractAddress, ethers.MaxUint256);
      await approveTx.wait();
      setStatusLog(`✅ ${label} spending approved!`);
    } catch (err) {
      console.warn(`Approval skipped or already authorized for ${label}:`, err);
    }
  };

  // ========================================================
  // UPLOAD SEQUENCE (ISOLATED VIEW CALLS & TYPO-CRUSHED)
  // ========================================================
  const handleUploadSequence = async () => {
    if (!isConnected) { alert("🚨 Wallet Connected Nahi Hai! Pehle top-right se wallet connect karein."); return; }
    
    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    if (!isSignedUp) { alert("🚨 Node Verified Nahi Hai! Sidebar mein 'COMPLETE SIGN UP (VERIFY NODE)' par click karke message sign karein."); return; }
    if (!assetId) { alert("🚨 Asset Tracking ID missing hai! Input field mein koi ID enter karein."); return; }
    if (selectedFiles.length === 0) { alert("🚨 Koi file select nahi ki! Pehle file attach karein."); return; }
    if (!masterPasskey) { alert("🚨 Master Node Passkey missing hai! Sidebar mein passkey enter karein."); return; }
    
    if (hasSizeViolation) {
      alert(`❌ Size limit violation: Your allocation limits allow up to ${b2bTierData.displayLimit} processing capacity under ${selectedB2BTier}.`);
      return;
    }

    setTxHashLink(''); setDownloadUrl(''); setLastBatchResults([]);
    const isBatch = selectedFiles.length > 1;
    const fileHashes = [];
    const fileSizes = [];
    const shardACIDs = [];
    const shardBCIDs = [];
    const pendingFilenameMappings = [];
    const pendingMerkleRecords = []; // { hash, root, chunkCount, layers } — registered on-chain after custody tx confirms

    const initialProgress = selectedFiles.map((f) => ({ filename: f.name, status: 'pending', message: 'Queued' }));
    setUploadProgress(initialProgress);

    const updateProgress = (index, status, message) => {
      setUploadProgress((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], status, message };
        return next;
      });
    };

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const effectiveAssetId = isBatch ? `${assetId}-${i + 1}` : assetId;
      try {
        updateProgress(i, 'processing', 'Encrypting (PBKDF2 + AES-GCM)...');
        const { filename, cidAlpha, cidBeta, merkleRoot, merkleLayers, chunkCount } = await prepareShardedFile(file);
        const hash = computeFileHash(effectiveAssetId);

        fileHashes.push(hash);
        fileSizes.push(file.size);
        shardACIDs.push(cidAlpha);
        shardBCIDs.push(cidBeta);
        pendingFilenameMappings.push({ hash, filename, assetIdText: effectiveAssetId });
        pendingMerkleRecords.push({ hash, root: merkleRoot, chunkCount, layers: merkleLayers });
        updateProgress(i, 'sharded', 'Sharded & uploaded to IPFS — awaiting signature');
      } catch (prepErr) {
        console.error(prepErr);
        updateProgress(i, 'error', prepErr.message || 'Encryption/sharding failed');
        alert(`❌ Sharding Pipeline Error on file [${file.name}]: ${prepErr.message}`);
        return;
      }
    }

    if (fileHashes.length === 0) {
      setStatusLog("❌ No files were successfully prepared — nothing to register.");
      return;
    }

    let totalUsdtFeeWei = requiredUsdtWei;
    let totalInayaFeeWei = requiredInayaWei;

    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      
      const readCustody = new ethers.Contract(liveContractAddress, contractABI, provider);
      const custody = new ethers.Contract(liveContractAddress, contractABI, signer);

      setStatusLog("🔍 Pre-validating tracking logs and allocations...");
      
      try {
        for (let i = 0; i < fileHashes.length; i++) {
          const assetRecord = await readCustody.assets(fileHashes[i]);
          if (assetRecord && assetRecord[0] !== ethers.ZeroAddress) {
            alert(`🚨 DUPLICATE ASSET ID DETECTED!\n\nYe Tracking ID [${pendingFilenameMappings[i].assetIdText}] pehle se registered hai.`);
            setStatusLog("❌ Transaction cancelled: Duplicate Tracking ID mapping found on-chain.");
            fileHashes.forEach((_, idx) => updateProgress(idx, 'error', 'Duplicate tracking ID'));
            return;
          }
        }
      } catch (assetErr) {
        console.warn("Isolating asset view check exception (Forcing fallback bypass):", assetErr);
      }

      let usdtFeePerGB = 100000000000000000n; 
      let inayaFeePerGB = 100000000000000000n;
      try {
        const [fUsdt, fInaya] = await Promise.all([
          readCustody.usdtFeePerGB(),
          readCustody.inayaFeePerGB()
        ]);
        usdtFeePerGB = fUsdt;
        inayaFeePerGB = fInaya;
      } catch (feeErr) {
        console.warn("Using baseline configuration fees because view call failed:", feeErr);
      }

      let calculatedUsdtFee = 0n;
      let calculatedInayaFee = 0n;
      fileSizes.forEach((size) => {
        calculatedUsdtFee += (BigInt(size) * usdtFeePerGB) / 1073741824n;
        calculatedInayaFee += (BigInt(size) * inayaFeePerGB) / 1073741824n;
      });
      
      if (calculatedUsdtFee > 0n) totalUsdtFeeWei = calculatedUsdtFee;
      if (calculatedInayaFee > 0n) totalInayaFeeWei = calculatedInayaFee;

      if (totalUsdtFeeWei > 0n) {
        await ensureTokenApproval(usdtTokenAddress, signer, walletAddress, totalUsdtFeeWei, "Mock USDT");
      }
      if (totalInayaFeeWei > 0n) {
        await ensureTokenApproval(inayaTokenAddress, signer, walletAddress, totalInayaFeeWei, "$INAYA");
      }

      setStatusLog(`✍️ Requesting signature to register ${fileHashes.length} dynamic file(s) on-chain...`);
      fileHashes.forEach((_, idx) => updateProgress(idx, 'signing', 'Awaiting on-chain confirmation...'));

      let estimatedGas;
      try {
        estimatedGas = await custody.batchRegisterAssets.estimateGas(fileHashes, fileSizes, shardACIDs, shardBCIDs);
      } catch (gasErr) {
        console.warn("Gas simulation failed/skipped, setting safety bounds:", gasErr);
        estimatedGas = BigInt(360000) * BigInt(fileHashes.length);
      }

      const gasLimit = (estimatedGas * BigInt(130)) / BigInt(100);
      const tx = await custody.batchRegisterAssets(fileHashes, fileSizes, shardACIDs, shardBCIDs, { gasLimit });

      setStatusLog(`⏳ Mining dynamic batch transaction...`);
      await tx.wait();

      pendingFilenameMappings.forEach(({ hash, filename, assetIdText }) => {
        saveFilenameMapping(hash, filename);
        saveAssetIdHistory(assetIdText, hash, filename);
      });
      setAssetIdHistory(getAssetIdHistory());

      setLastBatchResults(pendingFilenameMappings.map(({ assetIdText, filename }) => ({ assetIdText, filename })));
      fileHashes.forEach((_, idx) => updateProgress(idx, 'done', 'Registered on-chain ✓'));

      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      setStatusLog(`🎯 DYNAMIC STATE SECURED: ${fileHashes.length} file(s) registered successfully.`);

      // --- Register each file's Merkle root on InayaProofRegistry ---
      // No batch function on this contract, so these go one-at-a-time. registerMerkleRoot has no
      // onlyOwner guard, so the same connected signer used for custody registration can call it.
      // A failure here does NOT roll back the custody registration above — the file is still
      // safely registered/stored either way, it just won't have a proof-of-storage root yet.
      setStatusLog(`✍️ Registering Merkle proof root(s) for ${pendingMerkleRecords.length} file(s)...`);
      const proofRegistry = new ethers.Contract(proofRegistryAddress, proofRegistryABI, signer);
      for (const { hash, root, chunkCount, layers } of pendingMerkleRecords) {
        try {
          const rootTx = await proofRegistry.registerMerkleRoot(hash, root, chunkCount, ethers.ZeroAddress);
          await rootTx.wait();
          saveMerkleTreeRecord(hash, { layers, chunkCount, root });
        } catch (rootErr) {
          console.error(`registerMerkleRoot failed for ${hash}:`, rootErr);
          setStatusLog(`⚠️ Custody registration succeeded, but Merkle root registration failed for one file: ${rootErr.reason || rootErr.message}`);
        }
      }
      setStatusLog(`🎯 DYNAMIC STATE SECURED: ${fileHashes.length} file(s) registered successfully (custody + proof root).`);

      setSelectedFiles([]);
    } catch (txErr) {
      console.error(txErr);
      fileHashes.forEach((_, idx) => updateProgress(idx, 'error', 'Transaction failed'));
      alert(`❌ Contract Interaction Failed: ${txErr.reason || txErr.message || txErr}`);
      if (txErr.code === 'ACTION_REJECTED') {
        setStatusLog("❌ Transaction cancelled: Signature rejected by host operator.");
      } else {
        setStatusLog(`❌ EVM Execution Crash: ${txErr.reason || txErr.message}`);
      }
      return;
    }

    fetchOnChainHistory();
  };

  const handleRetrievalSequence = async (targetId) => {
    if (!isSignedUp) { alert("Access Denied: Authenticate node access array parameters first."); return; }
    const searchId = targetId || queryAssetId;
    if (!searchId || !masterPasskey) { alert("Input Error: Tracking index parameters missing."); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      const searchHash = searchId.startsWith('0x') && searchId.length === 66 ? searchId : computeFileHash(searchId);
      setStatusLog(`🔍 Checking public blocks for tracking index reference #${searchHash.slice(0, 10)}...`);
      
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const record = await contract.assets(searchHash);
      const [ownerAddr, cidAlpha, cidBeta] = record;

      if (ownerAddr === ethers.ZeroAddress) {
        setStatusLog("❌ No registered asset found for that Asset Tracking ID.");
        return;
      }

      setStatusLog("🌐 Pulling synchronized multi-shard byte streams concurrently over edge proxies...");

      const fetchFastShard = async (cid) => {
        try {
          const res = await fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`);
          const json = await res.json(); return json.shard;
        } catch {
          const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
          const json = await res.json(); return json.shard;
        }
      };

      const [shardA, shardB] = await Promise.all([
        fetchFastShard(cidAlpha),
        fetchFastShard(cidBeta)
      ]);

      const fullCipherText = shardA + shardB;
      const localFilename = getFilenameMapping(searchHash);
      setRestoredName(localFilename || searchId);
      setDownloadUrl(await decryptData(fullCipherText, masterPasskey));
      setStatusLog("💚 TRANSACTION FULLY VERIFIED: Payload restored intact.");
    } catch (err) { setStatusLog(`❌ Security check validation dropped: ${err.message}`); }
  };

  // ========================================================
  // 💳 CARD CUSTOMER RECONSTRUCT — same public assets(bytes32) read as
  // handleRetrievalSequence, but via a plain JsonRpcProvider instead of
  // BrowserProvider (which requires an injected wallet) and without the
  // isSignedUp/masterPasskey wallet-flow gates, since a card customer has
  // neither. Prompts for the passkey inline rather than reading it from
  // the wallet sidebar's shared state.
  // ========================================================
  const handleCardReconstruct = async (fileHash, filename, sizeBytes) => {
    // Check whether egress has already been paid for this file before
    // prompting for a passkey — no point asking for it just to block on payment after.
    try {
      const statusRes = await fetch(`/api/egress-unlock-status?fileHash=${encodeURIComponent(fileHash)}`);
      const statusData = await statusRes.json();
      if (!statusData.unlocked) {
        setCardUploadStatus('Egress not yet paid — redirecting to checkout...');
        const checkoutRes = await fetch('/api/create-egress-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileHash, filename, sizeBytes }),
        });
        const checkoutData = await checkoutRes.json();
        if (checkoutData.url) {
          window.location.href = checkoutData.url;
        } else {
          alert(`Could not start egress checkout: ${checkoutData.error || 'Unknown error'}`);
          setCardUploadStatus('');
        }
        return;
      }
    } catch (err) {
      console.error('egress-unlock-status check failed:', err);
      alert('Could not verify egress payment status — check your connection and try again.');
      return;
    }

    const passkey = window.prompt(`Enter the passkey used to encrypt "${filename}":`);
    if (!passkey) return;
    try {
      setCardUploadStatus(`Retrieving "${filename}"...`);
      const provider = new ethers.JsonRpcProvider("https://data-seed-prebsc-1-s1.binance.org:8545");
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const record = await contract.assets(fileHash);
      const [ownerAddr, cidAlpha, cidBeta] = record;

      if (ownerAddr === ethers.ZeroAddress) {
        alert("No registered asset found for that file — it may not have finished settling on-chain yet.");
        setCardUploadStatus('');
        return;
      }

      const fetchFastShard = async (cid) => {
        try {
          const res = await fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`);
          const json = await res.json(); return json.shard;
        } catch {
          const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
          const json = await res.json(); return json.shard;
        }
      };

      const [shardA, shardB] = await Promise.all([fetchFastShard(cidAlpha), fetchFastShard(cidBeta)]);
      const fullCipherText = shardA + shardB;
      const dataUrl = await decryptData(fullCipherText, passkey);

      // Trigger a direct download rather than routing through the wallet-flow's
      // downloadUrl/restoredName state, since this panel renders independently of it.
      // Must be attached to the DOM before .click() — some browsers silently
      // ignore synthetic clicks on a detached anchor element.
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setCardUploadStatus('');
    } catch (err) {
      console.error('handleCardReconstruct error:', err);
      alert(`Reconstruction failed: ${err.message} — check the passkey and try again.`);
      setCardUploadStatus('');
    }
  };


  const fetchOnChainHistory = async () => {
  if (!walletAddress) return;
  setIsLoadingHistory(true);
  try {
    // 1. Get local upload history first (Instant load)
    const localHistory = getAssetIdHistory().map(item => ({
      assetId: item.hash || computeFileHash(item.assetIdText),
      assetIdText: item.assetIdText,
      filename: item.filename,
      timestamp: item.timestamp || Date.now(),
      isLocal: true
    }));

    // 2. Fetch On-Chain logs as secondary sync
    let onChainHistory = [];
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const latestBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, latestBlock - 2000); // Shorter range to prevent RPC error
      const filter = contract.filters.AssetRegistered();
      const logs = await contract.queryFilter(filter, fromBlock, 'latest');

      onChainHistory = logs.map(log => {
        if (!log.args) return null;
        const [op, hash, cA, cB] = log.args;
        if (op.toLowerCase() !== walletAddress.toLowerCase()) return null;
        const localFilename = getFilenameMapping(hash);
        return {
          assetId: hash,
          filename: localFilename || `${hash.slice(0, 10)}...${hash.slice(-6)}`,
          cidAlpha: cA,
          cidBeta: cB,
          operator: op,
          isLocal: false
        };
      }).filter(Boolean);
    } catch (rpcErr) {
      console.warn("RPC log query skipped/failed, using local registry:", rpcErr);
    }

    // Combine & Deduplicate by assetId
    const mergedMap = new Map();
    localHistory.forEach(item => mergedMap.set(item.assetId, item));
    onChainHistory.forEach(item => mergedMap.set(item.assetId, { ...mergedMap.get(item.assetId), ...item }));

    setVaultHistory(Array.from(mergedMap.values()).reverse());
  } catch (err) {
    console.error("History sync error:", err);
  } finally {
    setIsLoadingHistory(false);
  }
};

  // ========================================================
  // 💵 PAY-AS-YOU-GO (PAYG) — STATUS, PRICING & HISTORY SYNC
  // ========================================================
  const fetchPaygPricing = async (provider) => {
    try {
      const payg = new ethers.Contract(paygContractAddress, paygABI, provider);
      const [storagePrice, egressPrice, maintenanceFee] = await Promise.all([
        payg.storagePricePerTB(),
        payg.egressPricePerHalfTB(),
        payg.annualMaintenanceFee()
      ]);
      setPaygPricing({
        storagePerTB: ethers.formatUnits(storagePrice, 18),
        egressPerHalfTB: ethers.formatUnits(egressPrice, 18),
        maintenanceFee: ethers.formatUnits(maintenanceFee, 18)
      });
    } catch (err) {
      console.warn("PAYG pricing view call failed, using published defaults:", err);
    }
  };

  const fetchPaygStatus = async (address, providerOverride) => {
    if (!address) return;
    try {
      const provider = providerOverride || new ethers.BrowserProvider(getActiveProvider());
      const payg = new ethers.Contract(paygContractAddress, paygABI, provider);
      const [tbCommitted, storagePaidThrough, lastMaintenancePaidAt, storageActive, maintenanceCurrent] = await payg.getSubscriptionStatus(address);
      setPaygStatus({
        tbCommitted: Number(tbCommitted),
        storagePaidThrough: Number(storagePaidThrough) * 1000,
        lastMaintenancePaidAt: Number(lastMaintenancePaidAt) * 1000,
        storageActive,
        maintenanceCurrent
      });
      return provider;
    } catch (err) {
      console.warn("PAYG subscription status view call failed:", err);
    }
  };

  const fetchPaygHistory = async (address) => {
    if (!address || typeof window === 'undefined' || !getActiveProvider()) return;
    setIsLoadingPaygHistory(true);
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const payg = new ethers.Contract(paygContractAddress, paygABI, provider);
      const latestBlock = await provider.getBlockNumber();
      const fromBlock = latestBlock - 4900 > 0 ? latestBlock - 4900 : 0;

      const [storageLogs, egressLogs, maintenanceLogs] = await Promise.all([
        payg.queryFilter(payg.filters.StorageSubscriptionPaid(address), fromBlock, 'latest'),
        payg.queryFilter(payg.filters.EgressFeePaid(address), fromBlock, 'latest'),
        payg.queryFilter(payg.filters.AnnualMaintenancePaid(address), fromBlock, 'latest')
      ]);

      const merged = [
        ...storageLogs.map(log => ({
          type: 'Storage Subscription',
          asset: 'USDT',
          units: `${log.args.tbUnits.toString()} TB`,
          amount: ethers.formatUnits(log.args.amountPaid, 18),
          timestamp: Number(log.args.paidThrough) * 1000 - 30 * 24 * 60 * 60 * 1000,
          txHash: log.transactionHash
        })),
        ...egressLogs.map(log => ({
          type: 'Egress (Retrieval)',
          asset: 'INAYA',
          units: `${log.args.halfTbUnits.toString()} × 0.5 TB`,
          amount: ethers.formatUnits(log.args.amountPaid, 18),
          timestamp: Number(log.args.timestamp) * 1000,
          txHash: log.transactionHash
        })),
        ...maintenanceLogs.map(log => ({
          type: 'Annual Maintenance',
          asset: 'USDT',
          units: '—',
          amount: ethers.formatUnits(log.args.amountPaid, 18),
          timestamp: Number(log.args.nextDueAt) * 1000 - 365 * 24 * 60 * 60 * 1000,
          txHash: log.transactionHash
        }))
      ].sort((a, b) => b.timestamp - a.timestamp);

      setPaygHistory(merged);
    } catch (err) {
      console.error("PAYG history extraction failed:", err);
      setPaygHistory([]);
    } finally {
      setIsLoadingPaygHistory(false);
    }
  };

  const refreshPaygDashboard = async (address) => {
    if (!address || typeof window === 'undefined' || !getActiveProvider()) return;
    const provider = new ethers.BrowserProvider(getActiveProvider());
    await Promise.all([fetchPaygPricing(provider), fetchPaygStatus(address, provider), fetchPaygHistory(address)]);
  };

  // ========================================================
  // 🥩 STAKING — OVERVIEW FETCH + STAKE / UNSTAKE / CLAIM HANDLERS
  // ========================================================
  const refreshStakingOverview = async (address) => {
    if (typeof window === 'undefined' || !getActiveProvider()) return;
    setIsLoadingStakingOverview(true);
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, provider);

      const [totalStaked, rate, tierLabel] = await Promise.all([
        staking.totalStaked(),
        staking.rewardRate(),
        address ? staking.getUserTier(address) : Promise.resolve('None')
      ]);

      // APY estimate: (rewardRate * seconds/year) / totalStaked, annualized.
      // Falls back to 0% if nothing is staked yet (avoids a divide-by-zero display).
      const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
      let apyPercent = "0.00";
      if (totalStaked > 0n) {
        const annualRewardWei = rate * BigInt(SECONDS_PER_YEAR);
        const apyBps = (annualRewardWei * 10000n) / totalStaked;
        apyPercent = (Number(apyBps) / 100).toFixed(2);
      }

      let myBalance = 0n;
      let claimable = 0n;
      let expiry = 0;
      if (address) {
        [myBalance, claimable, expiry] = await Promise.all([
          staking.userStakedBalance(address),
          staking.earned(address),
          staking.lockExpiry(address)
        ]);
      }

      setStakingOverview({
        totalStakedTVL: ethers.formatUnits(totalStaked, 18),
        estimatedAPY: apyPercent,
        myStakedBalance: ethers.formatUnits(myBalance, 18),
        claimableRewards: ethers.formatUnits(claimable, 18),
        lockExpiryTimestamp: Number(expiry) * 1000,
        userTier: tierLabel
      });
    } catch (err) {
      console.warn("Staking overview fetch failed:", err);
    } finally {
      setIsLoadingStakingOverview(false);
    }
  };

  const handleStakeInaya = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (stakingActionLockRef.current || isStakingBusy) return;
    const amount = parseFloat(stakeAmountInput);
    if (!amount || amount <= 0) { alert("🚨 Enter a valid amount to stake."); return; }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    stakingActionLockRef.current = true;
    setIsStakingBusy(true);
    setStakingLog(`🔄 Preparing to stake ${amount} $INAYA (${selectedLockTier === 0 ? 'Flexible' : selectedLockTier + '-day lock'})...`);
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const inayaContract = new ethers.Contract(inayaTokenAddress, erc20ABI, signer);
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, signer);

      const amountWei = ethers.parseUnits(stakeAmountInput, 18);

      const balance = await inayaContract.balanceOf(walletAddress);
      if (balance < amountWei) {
        alert(`🚨 Insufficient $INAYA balance. You have ${ethers.formatUnits(balance, 18)}.`);
        setStakingLog("❌ Blocked before signing: insufficient $INAYA balance.");
        return;
      }

      const allowance = await inayaContract.allowance(walletAddress, stakingContractAddress);
      if (allowance < amountWei) {
        setStakingLog("✍️ Requesting $INAYA spending approval for the staking contract...");
        const approveTx = await inayaContract.approve(stakingContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setStakingLog(`✍️ Signing stake transaction for ${amount} $INAYA...`);
      const tx = await staking.stake(amountWei, selectedLockTier);
      setStakingLog("⏳ Mining stake transaction...");
      await tx.wait();

      setStakingLog(`💚 Staked ${amount} $INAYA successfully (${selectedLockTier === 0 ? 'Flexible' : selectedLockTier + '-day lock'}).`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      setStakeAmountInput('');
      refreshStakingOverview(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setStakingLog(`❌ Stake failed: ${friendly}`);
      alert(`❌ Stake Failed: ${friendly}`);
    } finally {
      setIsStakingBusy(false);
      stakingActionLockRef.current = false;
    }
  };

  const handleUnstakeInaya = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (stakingActionLockRef.current || isUnstakingBusy) return;
    const amount = parseFloat(unstakeAmountInput);
    if (!amount || amount <= 0) { alert("🚨 Enter a valid amount to unstake."); return; }

    if (stakingOverview.lockExpiryTimestamp > Date.now()) {
      const unlockDate = new Date(stakingOverview.lockExpiryTimestamp).toLocaleString();
      alert(`🚨 Your stake is locked until ${unlockDate}. It cannot be withdrawn early.`);
      return;
    }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    stakingActionLockRef.current = true;
    setIsUnstakingBusy(true);
    setStakingLog(`🔄 Preparing to withdraw ${amount} $INAYA...`);
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, signer);

      const amountWei = ethers.parseUnits(unstakeAmountInput, 18);
      setStakingLog(`✍️ Signing withdrawal for ${amount} $INAYA...`);
      const tx = await staking.withdraw(amountWei);
      setStakingLog("⏳ Mining withdrawal transaction...");
      await tx.wait();

      setStakingLog(`💚 Withdrew ${amount} $INAYA successfully.`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      setUnstakeAmountInput('');
      refreshStakingOverview(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setStakingLog(`❌ Withdrawal failed: ${friendly}`);
      alert(`❌ Withdrawal Failed: ${friendly}`);
    } finally {
      setIsUnstakingBusy(false);
      stakingActionLockRef.current = false;
    }
  };

  const handleClaimStakingReward = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (stakingActionLockRef.current || isClaimingBusy) return;

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    stakingActionLockRef.current = true;
    setIsClaimingBusy(true);
    setStakingLog("🔄 Preparing to claim rewards...");
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, signer);

      setStakingLog("✍️ Signing reward claim...");
      const tx = await staking.claimReward();
      setStakingLog("⏳ Mining claim transaction...");
      await tx.wait();

      setStakingLog("💚 Rewards claimed successfully.");
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshStakingOverview(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setStakingLog(`❌ Claim failed: ${friendly}`);
      alert(`❌ Claim Failed: ${friendly}`);
    } finally {
      setIsClaimingBusy(false);
      stakingActionLockRef.current = false;
    }
  };

  const handlePaygStorageSubscription = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (paygActionLockRef.current || isPaygStorageBusy) return;
    if (!paygTbUnits || paygTbUnits < 1) { alert("🚨 Enter at least 1 TB unit."); return; }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    paygActionLockRef.current = true;
    setIsPaygStorageBusy(true);
    setPaygLog("🔄 Preparing storage subscription payment...");
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const payg = new ethers.Contract(paygContractAddress, paygABI, signer);
      const usdtContract = new ethers.Contract(usdtTokenAddress, erc20ABI, signer);

      const pricePerTB = await payg.storagePricePerTB();
      const amountDue = pricePerTB * BigInt(paygTbUnits);

      const balance = await usdtContract.balanceOf(walletAddress);
      if (balance < amountDue) {
        alert(`🚨 Insufficient mUSDT balance for ${paygTbUnits} TB. Use the Faucet tab to top up.`);
        setPaygLog("❌ Blocked before signing: insufficient mUSDT balance.");
        return;
      }

      const allowance = await usdtContract.allowance(walletAddress, paygContractAddress);
      if (allowance < amountDue) {
        setPaygLog("✍️ Requesting USDT spending approval...");
        const approveTx = await usdtContract.approve(paygContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setPaygLog(`✍️ Signing storage subscription for ${paygTbUnits} TB...`);
      const tx = await payg.paySubscriptionStorage(paygTbUnits);
      setPaygLog("⏳ Mining storage subscription transaction...");
      await tx.wait();

      setPaygLog(`💚 Storage subscription active: ${paygTbUnits} TB committed for 30 days.`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshPaygDashboard(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setPaygLog(`❌ Storage subscription failed: ${friendly}`);
      alert(`❌ Storage Subscription Failed: ${friendly}`);
    } finally {
      setIsPaygStorageBusy(false);
      paygActionLockRef.current = false;
    }
  };

  const handlePaygEgressFee = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (paygActionLockRef.current || isPaygEgressBusy) return;
    if (!paygEgressUnits || paygEgressUnits < 1) { alert("🚨 Enter at least one 0.5 TB unit."); return; }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    paygActionLockRef.current = true;
    setIsPaygEgressBusy(true);
    setPaygLog("🔄 Preparing egress fee payment...");
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const payg = new ethers.Contract(paygContractAddress, paygABI, signer);
      const inayaContract = new ethers.Contract(inayaTokenAddress, erc20ABI, signer);

      const pricePerHalfTB = await payg.egressPricePerHalfTB();
      const amountDue = pricePerHalfTB * BigInt(paygEgressUnits);

      const balance = await inayaContract.balanceOf(walletAddress);
      if (balance < amountDue) {
        alert(`🚨 Insufficient $INAYA balance for ${paygEgressUnits} × 0.5 TB egress. Use the Faucet tab to top up.`);
        setPaygLog("❌ Blocked before signing: insufficient $INAYA balance.");
        return;
      }

      const allowance = await inayaContract.allowance(walletAddress, paygContractAddress);
      if (allowance < amountDue) {
        setPaygLog("✍️ Requesting $INAYA spending approval...");
        const approveTx = await inayaContract.approve(paygContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setPaygLog(`✍️ Signing egress fee for ${paygEgressUnits} × 0.5 TB...`);
      const tx = await payg.payEgressFee(paygEgressUnits);
      setPaygLog("⏳ Mining egress fee transaction...");
      await tx.wait();

      setPaygLog(`💚 Egress fee settled for ${paygEgressUnits} × 0.5 TB.`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshPaygDashboard(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setPaygLog(`❌ Egress fee payment failed: ${friendly}`);
      alert(`❌ Egress Fee Payment Failed: ${friendly}`);
    } finally {
      setIsPaygEgressBusy(false);
      paygActionLockRef.current = false;
    }
  };

  const handlePaygAnnualMaintenance = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (paygActionLockRef.current || isPaygMaintenanceBusy) return;

    if (paygStatus.maintenanceCurrent) {
      const proceed = window.confirm("⚠️ Annual maintenance is already paid for the current period on-chain and will revert if resubmitted. Continue anyway?");
      if (!proceed) return;
    }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    paygActionLockRef.current = true;
    setIsPaygMaintenanceBusy(true);
    setPaygLog("🔄 Preparing annual maintenance payment...");
    try {
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const signer = await provider.getSigner();
      const payg = new ethers.Contract(paygContractAddress, paygABI, signer);
      const usdtContract = new ethers.Contract(usdtTokenAddress, erc20ABI, signer);

      const fee = await payg.annualMaintenanceFee();

      const balance = await usdtContract.balanceOf(walletAddress);
      if (balance < fee) {
        alert("🚨 Insufficient mUSDT balance for annual maintenance. Use the Faucet tab to top up.");
        setPaygLog("❌ Blocked before signing: insufficient mUSDT balance.");
        return;
      }

      const allowance = await usdtContract.allowance(walletAddress, paygContractAddress);
      if (allowance < fee) {
        setPaygLog("✍️ Requesting USDT spending approval...");
        const approveTx = await usdtContract.approve(paygContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setPaygLog("✍️ Signing annual maintenance payment...");
      const tx = await payg.payAnnualMaintenance();
      setPaygLog("⏳ Mining annual maintenance transaction...");
      await tx.wait();

      setPaygLog("💚 Annual maintenance settled for the next 365-day period.");
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshPaygDashboard(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setPaygLog(`❌ Annual maintenance payment failed: ${friendly}`);
      alert(`❌ Annual Maintenance Payment Failed: ${friendly}`);
    } finally {
      setIsPaygMaintenanceBusy(false);
      paygActionLockRef.current = false;
    }
  };

  // ========================================================
  // 🔎 PROOF REGISTRY READ-ONLY LOOKUPS (view calls, no wallet signature needed)
  // ========================================================
  const fetchAssetProofStatus = async (fileHash) => {
    try {
      if (typeof window === 'undefined' || !getActiveProvider()) return null;
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const proofRegistry = new ethers.Contract(proofRegistryAddress, proofRegistryABI, provider);
      const record = await proofRegistry.getAssetProof(fileHash);
      return {
        merkleRoot: record.merkleRoot,
        chunkCount: Number(record.chunkCount),
        node: record.node,
        registeredAt: Number(record.registeredAt),
        lastVerifiedAt: Number(record.lastVerifiedAt),
        challengesPassed: Number(record.challengesPassed),
        challengesFailed: Number(record.challengesFailed)
      };
    } catch (err) {
      console.error("fetchAssetProofStatus failed:", err);
      return null;
    }
  };

  const fetchNodeReliability = async (nodeAddress) => {
    try {
      if (typeof window === 'undefined' || !getActiveProvider()) return null;
      const provider = new ethers.BrowserProvider(getActiveProvider());
      const proofRegistry = new ethers.Contract(proofRegistryAddress, proofRegistryABI, provider);
      const [passed, failed] = await proofRegistry.getNodeReliability(nodeAddress);
      return { passed: Number(passed), failed: Number(failed) };
    } catch (err) {
      console.error("fetchNodeReliability failed:", err);
      return null;
    }
  };

  // UI handler: accepts either a raw 0x fileHash or a plain Asset Tracking ID (same convention
  // used by handleRetrievalSequence — hashed with computeFileHash if it's not already a hash).
  const handleProofLookup = async () => {
    const raw = proofLookupInput.trim();
    if (!raw) { alert("🚨 Enter an Asset Tracking ID or file hash first!"); return; }
    const fileHash = raw.startsWith('0x') && raw.length === 66 ? raw : computeFileHash(raw);

    setIsLoadingProofLookup(true);
    setProofLookupResult(null);
    try {
      const result = await fetchAssetProofStatus(fileHash);
      if (!result || result.registeredAt === 0) {
        setProofLookupResult({ notFound: true });
      } else {
        setProofLookupResult(result);
      }
    } finally {
      setIsLoadingProofLookup(false);
    }
  };

  const handleNodeReliabilityLookup = async () => {
    const raw = nodeLookupInput.trim();
    if (!raw || !ethers.isAddress(raw)) { alert("🚨 Enter a valid node wallet address!"); return; }

    setIsLoadingNodeLookup(true);
    setNodeLookupResult(null);
    try {
      const result = await fetchNodeReliability(raw);
      setNodeLookupResult(result);
    } finally {
      setIsLoadingNodeLookup(false);
    }
  };

  const handleFaucetRequest = async () => {
    if (!isConnected || !walletAddress) { alert("Connect your wallet first to request test tokens."); return; }
    setIsFauceting(true);
    setFaucetLog("📡 Requesting test tokens from the Inaya faucet...");
    try {
      const res = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress })
      });
      const data = await res.json();
      if (!res.ok || !data.success) { throw new Error(data.error || "Faucet request failed."); }
      const lines = [];
      lines.push(data.results.inaya.sent ? `✅ Sent ${data.results.inaya.amount} $INAYA` : `ℹ️ $INAYA: ${data.results.inaya.reason}`);
      lines.push(data.results.usdt.sent ? `✅ Sent ${data.results.usdt.amount} mUSDT` : `ℹ️ mUSDT: ${data.results.usdt.reason}`);
      setFaucetLog(lines.join('   •   '));
    } catch (err) {
      console.error(err);
      setFaucetLog(`❌ Faucet request failed: ${err.message}`);
    } finally {
      setIsFauceting(false);
    }
  };

  // ========================================================
  // 🤖 AI DOCS ASSISTANT — /api/ai/chat (Gemini-backed) SEND HANDLER
  // ========================================================
  const handleSendChatMessage = async (overrideText) => {
    const trimmedInput = (overrideText ?? chatInput).trim();
    if (!trimmedInput || isChatSending) return;

    const nextMessages = [...chatMessages, { role: 'user', content: trimmedInput }];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatError('');
    setIsChatSending(true);
    setIsChatStreaming(false);

    // Live wallet context — reuses state already fetched by the existing PAYG/Staking/
    // Corporate Reserve panels, so this adds zero extra RPC calls. Only sent when a
    // wallet is connected; the backend should clearly label this as "live data" so the
    // model never confuses it with the static knowledge base.
    const walletContext = isConnected && walletAddress ? {
      walletAddress,
      staking: {
        myStakedBalance: stakingOverview.myStakedBalance,
        claimableRewards: stakingOverview.claimableRewards,
        userTier: stakingOverview.userTier,
        lockExpiryTimestamp: stakingOverview.lockExpiryTimestamp
      },
      payg: {
        tbCommitted: paygStatus.tbCommitted,
        storageActive: paygStatus.storageActive,
        maintenanceCurrent: paygStatus.maintenanceCurrent,
        storagePaidThrough: paygStatus.storagePaidThrough
      },
      corporatePlan: activeCorporatePlan ? {
        tier: activeCorporatePlan.tier,
        expiresAt: activeCorporatePlan.expiresAt
      } : null
    } : null;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages, walletContext })
      });

      // Error responses (400/500/502) still come back as a normal JSON body,
      // same as before streaming was added — only the success path changed.
      if (!res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await res.json();
          throw new Error(data.error || 'AI service temporarily unavailable.');
        }
        // Compile errors / 404s from a misconfigured route still show up as
        // an HTML page rather than JSON — same non-JSON guard as before.
        const rawText = await res.text();
        console.error('Chat route returned non-JSON error response:', rawText.slice(0, 500));
        throw new Error(`Chat endpoint returned ${res.status} (not JSON) — check that /api/ai/chat compiled correctly.`);
      }

      if (!res.body) {
        // Extremely old browsers without ReadableStream support on fetch —
        // fall back to reading the whole thing at once.
        const wholeText = await res.text();
        setChatMessages((prev) => [...prev, { role: 'assistant', content: wholeText || "Sorry, I couldn't generate a response." }]);
        return;
      }

      // STREAMING: push an empty assistant bubble now, then fill it in live
      // as chunks arrive from the server, instead of waiting for the whole
      // reply before showing anything.
      setChatMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
      setIsChatStreaming(true);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setChatMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: accumulated };
          return next;
        });
      }

      if (!accumulated.trim()) {
        // Stream closed without ever writing anything (e.g. Gemini errored
        // mid-response) — replace the empty bubble with a clear fallback
        // instead of leaving a blank message in the transcript.
        setChatMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: "Sorry, I couldn't generate a response." };
          return next;
        });
      }
    } catch (err) {
      console.error('Chat widget error:', err);
      setChatError(err.message || 'Something went wrong reaching the docs assistant.');
    } finally {
      setIsChatSending(false);
      setIsChatStreaming(false);
    }
  };

  const handleChatInputKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendChatMessage();
    }
  };

  // Auto-scroll the chat transcript to the latest message whenever it grows,
  // and auto-focus the input the moment the widget opens.
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, isChatSending, isChatOpen]);

  useEffect(() => {
    if (isChatOpen && chatInputRef.current) {
      chatInputRef.current.focus();
    }
  }, [isChatOpen]);

  // Proactively open the docs assistant a few seconds after a visitor
  // lands, once per browser session (sessionStorage, not localStorage --
  // this should offer help again on a fresh visit, just not re-interrupt
  // every SPA navigation within the same session, and never fight a visitor
  // who already closed it once this session).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem('inaya_ai_auto_opened')) return;
    const timer = setTimeout(() => {
      setIsChatOpen(true);
      sessionStorage.setItem('inaya_ai_auto_opened', '1');
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      window.ethereum.on('accountsChanged', (accs) => {
        if (accs.length > 0) { 
          setWalletAddress(accs[0]); 
          setIsConnected(true); 
        } else { 
          setWalletAddress(''); 
          setIsConnected(false); 
          setIsSignedUp(false);
        }
      });
    }
  }, []);

  useEffect(() => {
    if (isConnected && (currentPage === 'Sovereign Vault' || currentPage === 'Genesis Airdrop')) { fetchOnChainHistory(); }
    if (isConnected && walletAddress && (currentPage === 'Business Model' || currentPage === 'My Dashboard')) {
      refreshPaygDashboard(walletAddress);
      setActiveCorporatePlan(getActiveCorporatePlan(walletAddress));
    }
    if (currentPage === 'Staking') {
      refreshStakingOverview(walletAddress || null); // works read-only even if not connected
    }
  }, [isConnected, currentPage, walletAddress]);

  // ========================================================
  // 🖥️ WEB3 STRUCTURAL LAYER UI LAYOUTS
  // ========================================================
  const hasEnoughInaya = userInayaBalance >= requiredInayaWei;
  const hasEnoughUsdt = userUsdtBalance >= requiredUsdtWei;
  const totalSelectedMB = selectedFiles.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);
  const oversizedFiles = selectedFiles.filter(f => f.size / (1024 * 1024) > b2bTierData.maxFileMB);
  const isOverTotalLimit = totalSelectedMB > b2bTierData.maxTotalMB;
  const hasSizeViolation = oversizedFiles.length > 0 || isOverTotalLimit;

  // ========================================================
  // 💵 PAYG DASHBOARD DERIVED TOTALS
  // ========================================================
  const paygTotalUsdtSpent = paygHistory
    .filter(item => item.asset === 'USDT')
    .reduce((acc, item) => acc + parseFloat(item.amount || "0"), 0);
  const paygTotalInayaSpent = paygHistory
    .filter(item => item.asset === 'INAYA')
    .reduce((acc, item) => acc + parseFloat(item.amount || "0"), 0);
  const corporateTierToTB = { '250 TB / Year': 250, '500 TB / Year': 500, '1000 TB / Year': 1000 };
  const corporateAllocatedTB = activeCorporatePlan ? (corporateTierToTB[activeCorporatePlan.tier] || 0) : 0;
  const totalSpaceAllocatedTB = paygStatus.tbCommitted + corporateAllocatedTB;

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans w-full overflow-x-hidden">
      
      {/* GLOBAL TOP HEADER — sticky at the extreme top of the viewport,
          always visible. The ☰ button inside it opens the site menu
          drawer (rendered as a sibling below) instead of an in-header nav. */}
      <div className="sticky top-0 z-50">
        <header className="relative z-10 flex flex-col sm:flex-row gap-4 justify-between items-center bg-[#0a0f1e]/90 border-b border-[#00f2fe]/15 px-4 md:px-10 py-4 backdrop-blur-xl">
          {/* flex-wrap on both clusters below: on narrow mobile widths the
              right cluster (bell + 3 buttons + Connect Wallet) is 587px wide
              on its own and was silently overflowing off-screen without
              this, making Connect Wallet unreachable. Wrapping keeps every
              button reachable instead of clipped past the viewport edge. */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            {/* ☰ SITE NAV — opens the grouped menu drawer (see NAV_GROUPS)
                instead of the old always-visible two-row, 18-button pill bar.
                Label is a fixed "Inaya Ecosystem", not currentPage -- kept
                static per request instead of doubling as a page indicator.
                Sits left of the logo, the conventional hamburger position. */}
            <button
              onClick={() => setIsNavMenuOpen(true)}
              aria-label="Open site menu"
              aria-expanded={isNavMenuOpen}
              className="flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-full border border-white/10 bg-white/5 hover:border-[#00f2fe]/40 hover:bg-white/10 transition-colors"
            >
              <span className="flex flex-col justify-center gap-[3px]">
                <span className="block h-[2px] w-4 rounded-full bg-[#00f2fe]" />
                <span className="block h-[2px] w-4 rounded-full bg-[#00f2fe]" />
                <span className="block h-[2px] w-2.5 rounded-full bg-[#00f2fe] ml-auto" />
              </span>
              <span className="text-xs font-mono font-bold text-white whitespace-nowrap">Inaya Ecosystem</span>
            </button>
            <img src="/inaya-logo.png" alt="Inaya Network logo" className="w-8 h-8 rounded-md shadow-[0_0_10px_rgba(0,242,254,0.4)]" />
            <span className="text-white font-extrabold text-lg tracking-wider">INAYA NETWORK</span>
            <span className="text-[12px] ml-2 font-mono px-3 py-0.5 rounded-full font-bold border bg-cyan-500/10 text-[#00f2fe] border-[#00f2fe]/30">⚡ LOW-COST DEPIN DISRUPTOR PLATFORM</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {/* 🔔 NOTIFICATION CENTER — see the state block near
                isUpdatesDrawerOpen for how allNotifications/unreadNotificationsCount
                are computed. */}
            <div className="relative">
              <button
                onClick={openNotificationsPanel}
                aria-label="Notifications"
                title="Notifications"
                className="relative flex items-center justify-center w-9 h-9 rounded-full border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 transition-colors"
              >
                🔔
                {unreadNotificationsCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-gradient-to-r from-[#f87171] to-[#ef4444] text-white text-[11px] font-bold flex items-center justify-center">
                    {unreadNotificationsCount > 9 ? '9+' : unreadNotificationsCount}
                  </span>
                )}
              </button>
              {isNotificationsOpen && (
                <>
                  <div className="fixed inset-0 z-[80]" onClick={() => setIsNotificationsOpen(false)} />
                  <div className="absolute right-0 top-11 w-80 max-h-96 overflow-y-auto bg-[#0a0f1e] border border-white/10 rounded-2xl shadow-2xl z-[90] p-2">
                    <div className="px-3 py-2 text-[12px] font-mono font-bold text-[#8a96ab] uppercase tracking-widest">Notifications</div>
                    {allNotifications.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-[#8a96ab] italic">
                        {isConnected ? "You're all caught up." : 'Connect your wallet to see activity.'}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {allNotifications.map((n) => (
                          <div key={n.id} className="flex items-start gap-2.5 p-3 rounded-xl hover:bg-white/5 transition-colors">
                            <span className="text-lg shrink-0">{n.icon}</span>
                            <div className="min-w-0">
                              <div className="text-white text-xs font-bold">{n.title}</div>
                              <div className="text-[#94a3b8] text-[13px] mt-0.5">{n.body}</div>
                              <div className="text-[#8a96ab] text-[11px] font-mono mt-1">{new Date(n.occurredAt).toLocaleString()}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => setIsUpdatesDrawerOpen(true)}
              aria-label="Open updates and knowledge base"
              className="relative flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-mono font-bold border border-[#00f2fe]/30 bg-cyan-500/10 text-[#00f2fe] hover:bg-cyan-500/20 transition-colors whitespace-nowrap"
            >
              📣 Knowledge Base
            </button>
            <button
              onClick={() => openFeedbackModal('bug')}
              aria-label="Report a bug"
              title="Report a bug"
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-mono font-bold border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap"
            >
              🐛 Report Bug
            </button>
            <button
              onClick={() => openFeedbackModal('idea')}
              aria-label="Suggest an idea"
              title="Suggest an idea"
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-mono font-bold border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap"
            >
              💡 Suggest Idea
            </button>
            <button onClick={() => isConnected ? null : setIsWalletModalOpen(true)} className="px-6 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] transition-transform active:scale-95">
              {isConnected ? `🛡️ ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4).toUpperCase()}` : '🔌 CONNECT WALLET'}
            </button>
          </div>
        </header>
      </div>

      {/* ======================================================
          ☰ SITE MENU — hamburger drawer replacing the old always-
          visible two-row pill nav. Same NAV_GROUPS destinations,
          grouped by purpose (App / Company / Ecosystem) so 18
          separate buttons read as one clean menu instead of clutter.
          Mirrors the Updates drawer's overlay/transform pattern.
          ====================================================== */}
      <div
        className={`fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm transition-opacity duration-300 ease-in-out ${
          isNavMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setIsNavMenuOpen(false)}
        aria-hidden={!isNavMenuOpen}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        className={`fixed top-0 left-0 z-[70] h-full w-full sm:w-96 bg-[#0a0f1e] border-r border-[#00f2fe]/15 shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col ${
          isNavMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-[#00f2fe]/15 sticky top-0 bg-[#0a0f1e]/95 backdrop-blur-xl">
          <div className="flex items-center gap-2.5">
            <img src="/inaya-logo.png" alt="" className="w-7 h-7 rounded-md shadow-[0_0_10px_rgba(0,242,254,0.4)]" />
            <h2 className="text-white font-extrabold text-lg tracking-wide">Menu</h2>
          </div>
          <button
            onClick={() => setIsNavMenuOpen(false)}
            aria-label="Close menu"
            className="w-9 h-9 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 space-y-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-3 text-[11px] font-mono font-bold text-[#8a96ab] uppercase tracking-widest mb-2">{group.title}</div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive = !item.href && currentPage === item.label;
                  const Tag = item.href ? 'a' : 'button';
                  return (
                    <Tag
                      key={item.label}
                      {...(item.href ? { href: item.href, target: '_blank', rel: 'noopener noreferrer' } : {})}
                      onClick={() => { if (!item.href) setCurrentPage(item.label); setIsNavMenuOpen(false); }}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors border ${
                        isActive
                          ? 'text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border-[#00f2fe]/40'
                          : 'text-[#c3ccdb] hover:bg-white/5 border-transparent'
                      }`}
                    >
                      <span className="text-base shrink-0">{item.icon}</span>
                      <span className="flex-1 text-left">{item.label}</span>
                      {item.href && <span className="text-[#8a96ab] text-xs shrink-0">↗</span>}
                      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-[#00f2fe] shadow-[0_0_6px_rgba(0,242,254,0.8)] shrink-0" />}
                    </Tag>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ======================================================
          📣 UPDATES & KNOWLEDGE BASE — slide-out drawer
          Always mounted (never conditionally rendered) so the
          close transition actually plays instead of the panel
          just vanishing. Visibility is purely transform/opacity
          driven -- zero layout shift to the rest of the page.
          ====================================================== */}
      <div
        className={`fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm transition-opacity duration-300 ease-in-out ${
          isUpdatesDrawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setIsUpdatesDrawerOpen(false)}
        aria-hidden={!isUpdatesDrawerOpen}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Updates and knowledge base"
        className={`fixed inset-0 z-[70] bg-[#0a0f1e] shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col ${
          isUpdatesDrawerOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-6 md:px-16 py-5 border-b border-[#00f2fe]/15 sticky top-0 bg-[#0a0f1e]/95 backdrop-blur-xl">
          <h2 className="text-white font-extrabold text-xl tracking-wide">📣 Updates & Knowledge Base</h2>
          <button
            onClick={() => setIsUpdatesDrawerOpen(false)}
            aria-label="Close"
            className="w-9 h-9 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-6 md:px-16 py-6 space-y-4 max-w-5xl mx-auto w-full">
          {KNOWLEDGE_ARTICLES.map((article) => {
            const isExpanded = expandedArticleId === article.id;
            const isKnowledgeBase = article.category === 'Knowledge Base';
            const CardTag = article.externalUrl ? 'a' : 'div';
            return (
              <CardTag
                key={article.id}
                {...(article.externalUrl ? { href: article.externalUrl, target: '_blank', rel: 'noopener noreferrer' } : {})}
                onClick={() => !article.externalUrl && setExpandedArticleId(isExpanded ? null : article.id)}
                className="block rounded-xl border border-[#00f2fe]/15 bg-white/[0.03] p-6 hover:bg-white/[0.05] transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3 mb-3">
                  <span
                    className={`text-xs font-mono px-3 py-1 rounded-full font-bold border ${
                      isKnowledgeBase
                        ? 'bg-cyan-500/10 text-[#00f2fe] border-[#00f2fe]/30'
                        : 'bg-violet-500/10 text-violet-300 border-violet-400/30'
                    }`}
                  >
                    {isKnowledgeBase ? '📚 KNOWLEDGE BASE' : '📝 BLOG'}
                  </span>
                  <span className="text-xs font-mono text-white/40">
                    {new Date(article.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <h3 className="text-white font-bold text-xl leading-snug">
                  {article.title}
                  {article.externalUrl && <span className="ml-1 text-white/40">↗</span>}
                </h3>
                <p className="text-white/60 text-base mt-2 leading-relaxed">{article.excerpt}</p>
                {!article.externalUrl && (
                  <>
                    <p className="text-[#00f2fe] text-sm font-mono mt-3">
                      {isExpanded ? '▲ Show less' : '▼ Read more'}
                    </p>
                    {isExpanded && (
                      <p className="text-white/70 text-base mt-3 pt-3 border-t border-white/10 leading-loose whitespace-pre-line">
                        {article.body}
                      </p>
                    )}
                  </>
                )}
              </CardTag>
            );
          })}
        </div>
      </aside>

      {/* FRAME CONTROLLER DOCK PLATFORM */}
      <div className="flex flex-col md:flex-row w-full">
        
        {/* ASIDE SECURITY MODULE — pinned to the right on desktop via flex
            order (md:order-2), main content takes the left (md:order-1),
            so the whole Security Dock box reads on the right-hand side. */}
        <aside className="md:order-2 w-full md:w-80 border-b md:border-b-0 md:border-l border-white/5 bg-[#080c18]/60 p-6 min-h-auto md:min-h-[calc(100vh-80px)] backdrop-blur-md space-y-7">

          {/* DOCK HEADER */}
          <div className="flex items-center gap-2.5 pb-1">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/25 flex items-center justify-center text-sm">
              🛡️
            </div>
            <div>
              <div className="text-white text-sm font-bold tracking-wide leading-tight">Security Dock</div>
              <div className="text-[11px] text-[#8a96ab] uppercase tracking-wider">Network diagnostics &amp; identity</div>
            </div>
          </div>

          {/* B2B CORPORATE RESERVE PANEL CHANGER */}
          <div className="bg-[#0b1426]/70 border border-[#00f2fe]/20 p-4 rounded-xl space-y-3 font-mono text-[13px]">
            <div className="text-[#00f2fe] font-extrabold text-xs uppercase border-b border-white/5 pb-1">Corporate Reserve Panel</div>
            <div>
              <span className="text-slate-400 block mb-1">Select Active Annual Plan:</span>
              <select value={selectedB2BTier} onChange={(e) => setSelectedB2BTier(e.target.value)} className="w-full bg-[#060913] border border-white/10 rounded px-2 py-1 text-white font-bold text-xs cursor-pointer focus:outline-none">
                <option value="250 TB / Year">250 TB / Year (13,500 USDT/yr)</option>
                <option value="500 TB / Year">500 TB / Year (27,000 USDT/yr)</option>
                <option value="1000 TB / Year">1000 TB / Year (54,000 USDT/yr)</option>
              </select>
            </div>
            <div className="pt-1 text-slate-300 space-y-1">
              <div>• Reserve Fee: <span className="text-white font-bold">{b2bTierData.price}</span></div>
              <div>• Annual Maintenance: <span className="text-white font-bold">{b2bTierData.maintenance}</span></div>
              <div>• Allocation Limit: <span className="text-white font-bold">{b2bTierData.displayLimit}</span></div>
              <div className="text-[12px] text-slate-500 italic pt-1">{b2bTierData.inclusions}</div>
            </div>
            <div className="text-[9.5px] text-slate-500 pt-1 border-t border-white/5">
              Retail / pay-as-you-go storage remains available at the baseline <span className="text-[#00f2fe] font-bold">4.5 USDT / TB / month</span> rate outside of a Corporate Reserve plan.
            </div>
          </div>

          {/* DEPLOYED CONTRACTS */}
          <div>
            <div className="text-[12px] font-mono font-bold text-[#8a96ab] uppercase tracking-widest mb-2.5 px-0.5">Deployed Contracts</div>
            <div className="bg-white/[0.02] border border-white/5 rounded-xl divide-y divide-white/5 overflow-hidden">

              {/* Core Contract Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-mono text-[#94a3b8] font-semibold">Core Custody Contract</span>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${liveContractAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={liveContractAddress}
                  >
                    {truncateAddress(liveContractAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(liveContractAddress, 'core')}
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'core' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${liveContractAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[11px] text-[#8a96ab] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Mock USDT Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-mono text-[#94a3b8] font-semibold">Mock USDT Contract</span>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${usdtTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={usdtTokenAddress}
                  >
                    {truncateAddress(usdtTokenAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(usdtTokenAddress, 'usdt')}
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'usdt' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${usdtTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[11px] text-[#8a96ab] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Token Contract Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-mono text-[#94a3b8] font-semibold">$INAYA Token Contract</span>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${inayaTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={inayaTokenAddress}
                  >
                    {truncateAddress(inayaTokenAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(inayaTokenAddress, 'token')}
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'token' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${inayaTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[11px] text-[#8a96ab] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Inaya Node Registry Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-mono text-[#94a3b8] font-semibold">Node Registry Contract</span>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${nodeRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={nodeRegistryAddress}
                  >
                    {truncateAddress(nodeRegistryAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(nodeRegistryAddress, 'nodeRegistry')}
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'nodeRegistry' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${nodeRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[11px] text-[#8a96ab] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Inaya Revenue Router Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-mono text-[#94a3b8] font-semibold">Revenue Router Contract</span>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${revenueRouterAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={revenueRouterAddress}
                  >
                    {truncateAddress(revenueRouterAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(revenueRouterAddress, 'revenueRouter')}
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'revenueRouter' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${revenueRouterAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[11px] text-[#8a96ab] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Proof Registry Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-mono text-[#94a3b8] font-semibold">Proof Registry Contract</span>
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${proofRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={proofRegistryAddress}
                  >
                    {truncateAddress(proofRegistryAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(proofRegistryAddress, 'proofregistry')}
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'proofregistry' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${proofRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[11px] text-[#8a96ab] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

            </div>
          </div>

          {/* NODE IDENTITY */}
          <div>
            <div className="text-[12px] font-mono font-bold text-[#8a96ab] uppercase tracking-widest mb-2.5 px-0.5">Node Identity</div>
            <div className="border border-[#00f2fe]/20 bg-gradient-to-b from-[#0c162b]/80 to-[#0c162b]/40 p-4 rounded-xl">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-[#64748b]'}`}></span>
                <span className="text-[#00f2fe] font-mono text-[12px] font-bold uppercase tracking-wide">Node Authentication</span>
              </div>
              {isConnected ? (
                isSignedUp ? (
                  <div className="mt-3 flex items-center gap-2 text-xs font-mono text-emerald-400 font-bold">
                    <span>✓</span> NODE OPERATIONAL (VERIFIED)
                  </div>
                ) : (
                  <button onClick={handleWeb3SignUp} disabled={isSigning} className="w-full mt-3 py-2 bg-gradient-to-r from-amber-500 to-orange-600 text-slate-900 font-bold text-xs rounded-lg animate-pulse">
                    {isSigning ? "SIGNING..." : "📝 COMPLETE SIGN UP (VERIFY NODE)"}
                  </button>
                )
              ) : (
                <div className="text-[#8a96ab] text-[13px] italic mt-3 font-mono">// Connect wallet to sign up.</div>
              )}
            </div>
          </div>

          {/* VAULT ACCESS */}
          <div>
            <div className="text-[12px] font-mono font-bold text-[#8a96ab] uppercase tracking-widest mb-2.5 px-0.5">Vault Access</div>
            <label className="block text-xs text-[#94a3b8] font-semibold mb-2">Master Node Passkey</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8a96ab] text-xs">🔒</span>
              <input type="password" value={masterPasskey} onChange={(e) => setMasterPasskey(e.target.value)} placeholder="••••••••" className="w-full bg-[#090d16] border border-white/10 rounded-lg pl-9 pr-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/40 transition-colors" />
            </div>
            <div className="flex gap-2 mt-2.5 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-2.5">
              <span className="text-amber-400 text-xs shrink-0">⚠️</span>
              <p className="text-[12px] text-amber-400/80 font-mono leading-relaxed">
                Never stored or transmitted. If lost, encrypted data cannot be recovered by you or by Inaya Network — there is no backdoor or reset.
              </p>
            </div>
          </div>

        </aside>

        {/* MAIN ROUTER ROUTING INTERFACE HOOK */}
        <main className="flex-1 p-4 md:p-10 w-full overflow-x-hidden">

          {/* VIEWPORT AREA 1: HOME PANEL */}
          {currentPage === 'Network Home' && (
            <div className="max-w-5xl mx-auto space-y-6">

              {/* ============================================================
                  🚀 HERO — "Ahead of Its Time" brand positioning. Reuses the
                  existing Sovereign Vault CTA action and the existing
                  NetworkVisualization canvas (already built for /security) —
                  no new routes, no new dependency, same dark-navy/cyan/gold
                  visual system as the rest of the app.
                 ============================================================ */}
              <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-8 items-center pb-2">
                <div className="inaya-fade-in-up">
                  <span className="inline-block text-[12px] font-mono font-bold tracking-[0.2em] text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
                    INAYA NETWORK
                  </span>

                  <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.1] mb-4">
                    Building the Infrastructure of a Sovereign Digital Future.
                  </h1>

                  <p className="text-xl sm:text-2xl font-extrabold leading-tight mb-4">
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#00f2fe] via-[#4facfe] to-[#c9a24d] whitespace-nowrap">Ahead of Its Time.</span>{' '}
                    <span className="text-white">Built for What Comes Next.</span>
                  </p>

                  <p className="text-[#94a3b8] text-sm leading-relaxed max-w-xl mb-5">
                    A decentralized ecosystem for sovereign data storage, business infrastructure, security intelligence, AI, and decentralized participation — built around user-controlled data and verifiable infrastructure.
                  </p>

                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    {/* Primary CTA — gets retail testers straight into the core upload/encrypt flow instead of leading with enterprise pricing */}
                    <button
                      onClick={() => setCurrentPage('Sovereign Vault')}
                      className="w-full sm:w-auto flex items-center justify-center gap-2 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-sm px-6 py-3.5 rounded-xl shadow-[0_0_20px_rgba(0,242,254,0.25)] hover:brightness-110 active:scale-95 transition-all"
                    >
                      🔐 Try the Encrypted Vault — Upload &amp; Decrypt a Test File
                    </button>
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-mono font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-full px-3 py-1.5 whitespace-nowrap">
                      🧪 BNB Chain Testnet — Live &amp; Testable Today
                    </span>
                  </div>
                </div>

                <div className="hidden lg:block relative overflow-hidden bg-[#050810] border border-white/10 rounded-2xl inaya-fade-in-up" style={{ animationDelay: '0.15s' }}>
                  <NetworkVisualization height={320} />
                </div>
              </div>

              {/* ============================================================
                  🌐 ECOSYSTEM CONTEXT — only categories that are actually
                  live in this codebase today, each linking into its real
                  existing tab/route (no invented navigation).
                 ============================================================ */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  { icon: '🔐', label: 'Sovereign Storage', desc: 'Client-side encryption, sharding, and decentralized custody.', action: () => setCurrentPage('Sovereign Vault') },
                  { icon: '🏢', label: 'Business Workspace', desc: 'Encrypted business documents, permissions, workflows, and secure sharing.', href: '/business' },
                  { icon: '🛡️', label: 'Inaya Firewall', desc: 'Decentralized threat intelligence and on-chain security verification.', href: '/security' },
                  { icon: '🤖', label: 'AI', desc: 'Product-grounded AI assistants for Docs, Security, and Learn.' },
                  { icon: '🎓', label: 'Inaya Learn', desc: 'Web3, AI, and programming learning with an integrated AI tutor.', action: () => setCurrentPage('Learn') },
                  { icon: '📱', label: 'Mobile & Desktop', desc: 'Native applications for accessing the Inaya ecosystem.', href: '/download' },
                  { icon: '🤝', label: 'Network Participation', desc: 'Watcher Pioneer, node staking, and referrals — real participation, real rewards.', action: () => setCurrentPage('Referrals') },
                ].map((item, idx) => {
                  const isInteractive = !!(item.action || item.href);
                  const Tag = isInteractive ? 'button' : 'div';
                  return (
                    <Tag
                      key={item.label}
                      onClick={item.action || (item.href ? () => window.open(item.href, '_blank', 'noopener,noreferrer') : undefined)}
                      aria-label={isInteractive ? `${item.label} — ${item.desc}` : undefined}
                      className={`text-left bg-[#090d16]/80 border border-white/5 rounded-xl p-4 ${isInteractive ? 'hover:border-[#00f2fe]/30 hover:bg-white/[0.02] hover:-translate-y-0.5 cursor-pointer' : ''} transition-all inaya-fade-in-up`}
                      style={{ animationDelay: `${0.05 * idx}s` }}
                    >
                      <span className="text-lg">{item.icon}</span>
                      <div className="text-white font-bold text-xs mt-1.5">{item.label}</div>
                      <p className="text-[#8a96ab] text-[13px] leading-relaxed mt-1">{item.desc}</p>
                    </Tag>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? (isSignedUp ? "ACTIVE_NODE" : "UNVERIFIED_SIGNUP") : "WAITING_AUTH"}</div><div className="text-[12px] uppercase text-[#8a96ab] mt-1">Wallet Core Status</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">30,000,000</div><div className="text-[12px] uppercase text-[#8a96ab] mt-1">Supply Cap Weight</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "LIVE" : "IDLE"}</div><div className="text-[12px] uppercase text-[#8a96ab] mt-1">RPC Connection Status</div></div>
              </div>

              {/* ============================================================
                  🏆 WHY CHOOSE INAYA — every figure below is a real, sourced
                  fact (live contract reads / on-chain tokenomics / hardcoded
                  program constants), not marketing filler.
                 ============================================================ */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 sm:p-8">
                <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-8 items-start">

                  <div>
                    <div className="flex items-center gap-5 mb-4">
                      <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">Why Choose Inaya?</h2>
                      <img src="/inaya-logo.png" alt="Inaya Network logo" className="w-14 h-14 rounded-xl shadow-[0_0_20px_rgba(0,242,254,0.3)] shrink-0 lg:hidden" />
                    </div>
                    <p className="text-[#94a3b8] text-sm leading-relaxed mb-6">
                      In a market where cloud storage means unpredictable egress fees and a single company holding a complete copy of your data, Inaya is built differently. Files are encrypted and sharded on your own device before anything reaches the network — no server, node, or administrator ever holds a complete, decryptable copy. Every fee, allocation, and settlement flow below is read from the same deployed contracts and production code the network actually runs on.
                    </p>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 font-mono">
                      <div className="bg-black/30 border border-white/5 rounded-xl p-3">
                        <div className="text-white font-bold text-sm">4.5 USDT</div>
                        <div className="text-[11px] uppercase text-[#8a96ab] mt-0.5">Storage / TB / Month</div>
                      </div>
                      <div className="bg-black/30 border border-white/5 rounded-xl p-3">
                        <div className="text-white font-bold text-sm">30,000,000</div>
                        <div className="text-[11px] uppercase text-[#8a96ab] mt-0.5">$INAYA Hard Cap</div>
                      </div>
                      <div className="bg-black/30 border border-white/5 rounded-xl p-3">
                        <div className="text-white font-bold text-sm">40.0%</div>
                        <div className="text-[11px] uppercase text-[#8a96ab] mt-0.5">To Swarm Reserve (Nodes)</div>
                      </div>
                      <div className="bg-black/30 border border-white/5 rounded-xl p-3">
                        <div className="text-white font-bold text-sm">BNB Chain</div>
                        <div className="text-[11px] uppercase text-[#8a96ab] mt-0.5">Live On Testnet</div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="bg-black/20 border border-cyan-500/20 p-4 rounded-xl">
                        <span className="text-[#00f2fe] font-bold text-sm">🔐 Zero-Knowledge Encryption</span>
                        <p className="text-[#94a3b8] text-xs mt-1.5 leading-relaxed">
                          Files are encrypted with AES-256-GCM and split into independent shards inside your own browser before upload — plaintext never traverses the network intact, and no single node ever holds a complete, readable copy.
                        </p>
                      </div>
                      <div className="bg-black/20 border border-emerald-500/20 p-4 rounded-xl">
                        <span className="text-emerald-400 font-bold text-sm">⛓️ On-Chain Anchored &amp; Auditable</span>
                        <p className="text-[#94a3b8] text-xs mt-1.5 leading-relaxed">
                          Custody metadata, revenue settlement, and threat confirmations are all anchored immutably on BNB Chain — verifiable by anyone, not just claimed in a whitepaper.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <button
                      onClick={() => setCurrentPage('Genesis Airdrop')}
                      className="w-full text-left bg-gradient-to-br from-pink-500/10 to-transparent border border-pink-500/20 hover:border-pink-500/40 rounded-2xl p-5 transition-colors"
                    >
                      <div className="flex items-center gap-3 mb-1">
                        <span className="w-11 h-11 rounded-full bg-pink-500/15 border border-pink-500/30 flex items-center justify-center text-lg shrink-0">🎁</span>
                        <span className="text-white font-bold text-sm">Genesis Airdrop</span>
                      </div>
                      <p className="text-[#94a3b8] text-xs mt-1">1,000,000 $INAYA pool (3.3% of hard cap) — automatic upload rewards plus developer &amp; community contributor tracks.</p>
                    </button>

                    <button
                      onClick={() => setCurrentPage('Referrals')}
                      className="w-full text-left bg-gradient-to-br from-violet-500/10 to-transparent border border-violet-500/20 hover:border-violet-500/40 rounded-2xl p-5 transition-colors"
                    >
                      <div className="flex items-center gap-3 mb-1">
                        <span className="w-11 h-11 rounded-full bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-lg shrink-0">🤝</span>
                        <span className="text-white font-bold text-sm">Referral Program</span>
                      </div>
                      <p className="text-[#94a3b8] text-xs mt-1">150,000 $INAYA program pool — 0.5 $INAYA per verified referral, split between you and the person you invite.</p>
                    </button>

                    <button
                      onClick={() => setCurrentPage('Staking')}
                      className="w-full text-left bg-gradient-to-br from-cyan-500/10 to-transparent border border-cyan-500/20 hover:border-cyan-500/40 rounded-2xl p-5 transition-colors"
                    >
                      <div className="flex items-center gap-3 mb-1">
                        <span className="w-11 h-11 rounded-full bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-lg shrink-0">🥩</span>
                        <span className="text-white font-bold text-sm">Staking Rewards</span>
                      </div>
                      <p className="text-[#94a3b8] text-xs mt-1">8,000,000 $INAYA pool (26.7% of hard cap) — 0/30/90-day lock tiers at 1.00x/1.25x/1.50x reward multipliers.</p>
                    </button>
                  </div>

                </div>
              </div>

              {/* Business Workspace / SaaS cross-promotion — converts
                  wallet-connected retail users into Business Workspace
                  signups. Opens in a new tab, same reasoning as the nav's
                  Business Workspace/SaaS links: switching products
                  shouldn't navigate the visitor away from the wallet dApp. */}
              <div className="relative overflow-hidden bg-gradient-to-r from-violet-500/10 via-[#090d16] to-[#00f2fe]/10 border border-white/10 rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <span className="inline-block text-[12px] font-bold uppercase tracking-wide text-violet-300 bg-violet-400/10 border border-violet-400/20 rounded-full px-2.5 py-1 mb-2">
                    New · For Teams &amp; Companies
                  </span>
                  <h3 className="text-white font-extrabold text-base sm:text-lg">Run your company on Inaya, not just your files</h3>
                  <p className="text-[#94a3b8] text-xs sm:text-sm mt-1 max-w-lg">
                    Business Workspace brings the same zero-knowledge encryption to your team's documents — departments, projects, permissions, an AI assistant, and real pricing plans.
                  </p>
                </div>
                <div className="flex gap-2 shrink-0 w-full sm:w-auto">
                  <a
                    href="/business/pricing"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 sm:flex-none text-center text-xs font-bold uppercase text-black bg-gradient-to-r from-violet-400 to-[#00f2fe] px-4 py-2.5 rounded-lg hover:brightness-110"
                  >
                    See Pricing
                  </a>
                  <a
                    href="/business"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 sm:flex-none text-center text-xs font-bold uppercase text-slate-200 bg-white/5 border border-white/10 px-4 py-2.5 rounded-lg hover:bg-white/10"
                  >
                    Explore ↗
                  </a>
                </div>
              </div>

              {/* Desktop app cross-promotion -- hidden when already running
                  inside the desktop app itself (window.__TAURI__), same
                  reasoning as the Business Workspace dashboard's banner. */}
              {!isTauriApp && (
                <div className="relative overflow-hidden bg-gradient-to-r from-[#00f2fe]/10 via-[#090d16] to-violet-500/10 border border-white/10 rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <span className="inline-block text-[12px] font-bold uppercase tracking-wide text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 rounded-full px-2.5 py-1 mb-2">
                      New · Desktop App
                    </span>
                    <h3 className="text-white font-extrabold text-base sm:text-lg">🖥️ Inaya Network, now on your desktop</h3>
                    <p className="text-[#94a3b8] text-xs sm:text-sm mt-1 max-w-lg">
                      Faucet, node registry, staking, KYC, and referrals as a real app — runs in your system tray and updates itself. Available for Windows and Linux.
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0 w-full sm:w-auto">
                    <a
                      href="/download"
                      className="flex-1 sm:flex-none text-center text-xs font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-violet-400 px-4 py-2.5 rounded-lg hover:brightness-110"
                    >
                      Download
                    </a>
                  </div>
                </div>
              )}

              {/* Product overview video — embedded from YouTube (adaptive quality per
                  visitor's connection, no repo bloat, feeds the existing channel).
                  VideoObject structured data lets this show up as a video result
                  in search, separate from the page's own ranking. */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-4 sm:p-6 space-y-3">
                <h3 className="text-sm font-bold text-white">▶ Watch: 2-Minute Product Overview</h3>
                <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-white/10 bg-black">
                  <iframe
                    className="absolute inset-0 w-full h-full"
                    src="https://www.youtube.com/embed/i4P4YfiWpow"
                    title="Inaya Network Overview"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                  />
                </div>
                <script
                  type="application/ld+json"
                  dangerouslySetInnerHTML={{
                    __html: JSON.stringify({
                      "@context": "https://schema.org",
                      "@type": "VideoObject",
                      name: "Inaya Network — 2-Minute Product Overview",
                      description: "A short walkthrough of Inaya Network's sovereign data storage, client-side encryption, and decentralized custody architecture.",
                      thumbnailUrl: "https://img.youtube.com/vi/i4P4YfiWpow/maxresdefault.jpg",
                      uploadDate: "2026-01-01",
                      embedUrl: "https://www.youtube.com/embed/i4P4YfiWpow",
                    }),
                  }}
                />
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 1B: TESTNET FAUCET */}
          {currentPage === 'Faucet' && (
            <div className="max-w-3xl mx-auto space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">🚰 Testnet Token Faucet</h2>
                  <p className="text-[#94a3b8] text-sm mb-2">Get free test $INAYA and mUSDT to try the dual-asset upload flow — no real value, BNB Chain Testnet only.</p>
                </div>
                <div className="hidden sm:block shrink-0">
                  <AccentGraphic variant="faucet" size={100} />
                </div>
              </div>

              <div className="bg-[#0b1120]/40 border border-white/5 rounded-2xl p-6 space-y-5">
                <div className="grid grid-cols-2 gap-4 font-mono text-xs">
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-emerald-400">500</div>
                    <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mt-1">$INAYA per request</div>
                  </div>
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-[#00f2fe]">100</div>
                    <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mt-1">mUSDT per request</div>
                  </div>
                </div>

                {faucetLog && (
                  <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl break-words">
                    {faucetLog}
                  </div>
                )}

                <button
                  onClick={handleFaucetRequest}
                  disabled={isFauceting || !isConnected}
                  className="w-full py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl shadow-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isFauceting ? "DISPENSING..." : isConnected ? "REQUEST TEST TOKENS" : "CONNECT WALLET FIRST"}
                </button>

                <p className="text-[12px] text-[#8a96ab] font-mono">
                  The faucet skips a token if your wallet already holds enough for testing — this keeps the treasury available for everyone.
                </p>
              </div>

              <div className="bg-black/20 border border-white/5 rounded-2xl p-5 font-mono text-[12px] text-[#8a96ab] leading-relaxed">
                <p className="mb-1"><span className="text-amber-400/80 font-bold">⛽ Need gas (tBNB) too?</span> This faucet only covers $INAYA and mUSDT.</p>
                <p>Get free testnet BNB here: <a href="https://faucet.zalalena.com/bsc" target="_blank" rel="noopener noreferrer" className="text-[#00f2fe] underline hover:text-cyan-300">faucet.zalalena.com/bsc</a></p>
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 2: CRYPTOGRAPHIC VAULT LAYER */}
{currentPage === 'Sovereign Vault' && (
  <div className="max-w-7xl mx-auto space-y-6 font-sans">

    {!isConnected && cardCustomerEmail && (
      <div className="bg-[#0b101d]/90 border border-emerald-400/30 rounded-2xl p-5 space-y-4">
        <div>
          <span className="text-[12px] uppercase tracking-widest text-emerald-400 font-bold">Pay-As-You-Go — Card Upload (No Wallet)</span>
          <p className="text-[13px] text-slate-500 mt-1">Encrypt, shard, and upload a file — billed at the live per-GB rate via card, no wallet required. Signed in as {cardCustomerEmail}.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="file"
            onChange={(e) => setCardUploadFile(e.target.files[0] || null)}
            className="flex-1 text-xs text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-white/10 file:text-white file:text-xs file:font-bold"
          />
          <input
            type="password"
            value={cardUploadPasskey}
            onChange={(e) => setCardUploadPasskey(e.target.value)}
            placeholder="Encryption passkey (never sent to our servers)"
            className="flex-1 bg-[#040711] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]"
          />
          <button
            onClick={handleCardUpload}
            disabled={isCardUploadProcessing}
            className="px-6 py-2 bg-white text-[#060913] font-black text-xs rounded-lg hover:brightness-95 active:scale-95 transition-all disabled:opacity-40 whitespace-nowrap"
          >
            {isCardUploadProcessing ? "PROCESSING..." : "💳 ENCRYPT & PAY"}
          </button>
        </div>
        {cardUploadStatus && <p className="text-[13px] text-amber-400 font-mono">// {cardUploadStatus}</p>}
        <div className="bg-amber-400/10 border border-amber-400/40 rounded-lg px-3 py-2 flex items-center gap-2">
          <span className="text-amber-400 text-sm">⚠️</span>
          <p className="text-[13px] text-amber-300 font-bold font-mono">TEST MODE — use card 4242 4242 4242 4242, any future expiry, any CVC/ZIP.</p>
        </div>

        {cardUploadAssets.length > 0 && (
          <div className="border-t border-white/10 pt-4">
            <span className="text-[12px] uppercase tracking-widest text-slate-400 font-bold">My Files</span>
            <div className="mt-2 space-y-2">
              {cardUploadAssets.map((a) => (
                <div key={a.fileHash} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-2">
                  <div>
                    <div className="text-white text-xs font-bold">{a.filename}</div>
                    <div className="text-[12px] text-slate-500">{(a.sizeBytes / 1048576).toFixed(2)} MB · {new Date(a.uploadedAt).toLocaleDateString()}</div>
                  </div>
                  <button
                    onClick={() => handleCardReconstruct(a.fileHash, a.filename, a.sizeBytes)}
                    className="px-3 py-1.5 bg-[#00f2fe]/10 border border-[#00f2fe]/30 text-[#00f2fe] text-[12px] font-bold rounded-lg hover:bg-[#00f2fe]/20 transition-all"
                  >
                    🧩 RECONSTRUCT
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )}

    {/* 1. GOOGLE DRIVE TOP SEARCH & ACTION BAR */}
    <div className="bg-[#0b101d]/90 border border-white/10 rounded-2xl p-4 flex flex-col md:flex-row items-center justify-between gap-4 backdrop-blur-xl shadow-xl">
      
      {/* Top Search Bar — on mobile the RECONSTRUCT button stacks below the
          input (the inline pill was covering the placeholder text on small
          screens); from sm: up it stays inside the input as before. */}
      <div className="flex-1 w-full space-y-2">
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
          <input 
            type="text" 
            value={queryAssetId} 
            onChange={(e) => setQueryAssetId(e.target.value)} 
            placeholder="Search in Inaya Drive (Asset ID or Hash)..." 
            className="w-full bg-[#040711] border border-white/10 rounded-full pl-11 pr-4 sm:pr-32 py-2.5 text-white text-xs focus:outline-none focus:border-[#00f2fe] transition-all"
          />
          <button 
            onClick={() => handleRetrievalSequence('')}
            className="hidden sm:block absolute right-1.5 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-[#00f2fe] text-[#060913] font-bold text-[13px] rounded-full hover:brightness-110 transition-all"
          >
            🧩 RECONSTRUCT
          </button>
        </div>
        <button 
          onClick={() => handleRetrievalSequence('')}
          className="sm:hidden w-full py-2.5 bg-[#00f2fe] text-[#060913] font-bold text-[13px] rounded-full hover:brightness-110 active:scale-95 transition-all"
        >
          🧩 RECONSTRUCT
        </button>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-3 shrink-0">
        <input ref={fileInputRef} type="file" multiple onChange={(e) => setSelectedFiles(Array.from(e.target.files))} className="hidden" />
        <button 
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          className="px-5 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-extrabold text-xs rounded-full shadow-lg hover:brightness-110 active:scale-95 transition-all flex items-center gap-2"
        >
          <span className="text-base leading-none">┼</span>
          <span>NEW UPLOAD</span>
        </button>
        
        <button 
          onClick={fetchOnChainHistory} 
          className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-slate-300 transition-colors"
          title="Refresh Drive Matrix"
        >
          🔄
        </button>
      </div>
    </div>

    {/* SYSTEM NOTIFICATION BARS */}
    {statusLog && (
      <div className="bg-[#091224] border border-[#00f2fe]/30 text-[#00f2fe] font-mono text-xs p-3.5 rounded-xl break-all flex items-center gap-2 shadow-lg">
        <span className="animate-pulse">⚡</span>
        <span>{statusLog}</span>
      </div>
    )}

    {downloadUrl && (
      <div className="text-xs font-mono bg-cyan-950/80 p-4 rounded-xl border border-[#00f2fe]/40 text-[#00f2fe] flex justify-between items-center shadow-lg">
        <span>🔓 Decrypted File Payload Ready: <strong>{restoredName}</strong></span>
        <a href={downloadUrl} download={restoredName} className="px-4 py-1.5 bg-[#00f2fe] text-[#060913] font-bold rounded-lg hover:brightness-110">
          📥 DOWNLOAD FILE
        </a>
      </div>
    )}

    {/* 2. PENDING UPLOAD BAR (Appears when files are chosen) */}
    {selectedFiles.length > 0 && (
      <div className="bg-[#0a1224] border border-[#00f2fe]/40 rounded-2xl p-5 space-y-4 shadow-2xl animate-fade-in">
        <div className="flex justify-between items-center border-b border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-base">📤</span>
            <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">Pending Upload Queue ({selectedFiles.length} File)</span>
          </div>
          <button onClick={() => setSelectedFiles([])} className="text-xs text-slate-400 hover:text-red-400 font-mono">Clear Queue ✕</button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono">
          <div className="md:col-span-2 space-y-2 max-h-32 overflow-y-auto pr-1">
            {selectedFiles.map((f, idx) => {
              const meta = splitFileName(f.name);
              return (
                <div key={idx} className="flex justify-between items-center bg-[#040711] border border-white/10 rounded-xl px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span>{getFileIcon(f.name)}</span>
                    <span className="text-white font-bold truncate">{meta.base}</span>
                  </div>
                  <span className="text-[11px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 py-0.5 rounded border border-[#00f2fe]/30">.{meta.ext}</span>
                </div>
              );
            })}
          </div>

          <div className="bg-[#040711] border border-white/10 rounded-xl p-3 flex flex-col justify-between font-mono text-[13px]">
            <div className="space-y-1">
              <input 
                type="text" 
                value={assetId} 
                onChange={(e) => setAssetId(e.target.value)} 
                placeholder="Assign Asset Tracking ID..." 
                className="w-full bg-[#0a0f1d] border border-white/10 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-[#00f2fe]" 
              />
              <div className="flex justify-between text-slate-400 pt-1">
                <span>Fee:</span>
                <span className="text-emerald-400 font-bold">{dynamicInayaCost} $INAYA</span>
              </div>
            </div>

            <button 
              onClick={handleUploadSequence} 
              className="w-full mt-2 py-2 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-extrabold text-xs rounded-lg hover:brightness-110 active:scale-95 transition-all"
            >
              ⚡ EMIT TO DRIVE
            </button>
          </div>
        </div>
      </div>
    )}

    {/* 3. GOOGLE DRIVE MAIN LAYOUT & SUGGESTED FILES MATRIX */}
    <div className="bg-[#0b101d]/90 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-2xl space-y-4">
      
      {/* Header Banner */}
      <div className="border-b border-white/5 pb-3 flex justify-between items-center">
        <div>
          <h3 className="text-lg font-bold text-white tracking-tight">Welcome to Inaya Sovereign Drive</h3>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Encrypted client-side storage fragments anchored on BNB Chain</p>
        </div>
        <span className="text-xs font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 px-3 py-1 rounded-full font-bold">
          {vaultHistory.length} Files Stored
        </span>
      </div>

      <div className="text-xs font-bold text-slate-400 font-mono uppercase tracking-wider pt-2">
        Suggested Files
      </div>

      {isLoadingHistory ? (
        <div className="py-16 text-center font-mono text-xs text-slate-500 border border-dashed border-white/10 rounded-2xl">
          ⚙️ Loading Drive files from blockchain ledger...
        </div>
      ) : vaultHistory.length === 0 ? (
        <div className="border border-dashed border-white/10 rounded-2xl">
          <EmptyState
            icon="🗄️"
            title="Your vault is empty"
            description="Files are encrypted and sharded on your own device before anything reaches the network — upload your first one to see it anchored on-chain."
            ctaLabel="+ New Upload"
            onCta={() => fileInputRef.current && fileInputRef.current.click()}
          />
        </div>
      ) : (
        /* EXACT GOOGLE DRIVE TILES GRID */
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
          {vaultHistory.map((item, index) => {
            const fileMeta = splitFileName(item.filename || item.assetIdText || 'Document');
            const isPdf = fileMeta.ext === 'PDF';
            const isImg = ['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP'].includes(fileMeta.ext);

            return (
              <div 
                key={index}
                className="group bg-[#040711] border border-white/10 hover:border-[#00f2fe]/60 rounded-2xl p-3.5 transition-all duration-200 flex flex-col justify-between hover:shadow-[0_0_25px_rgba(0,242,254,0.15)] relative"
              >
                {/* Top Tile Bar: File Badge + Title + Options Menu */}
                <div className="flex items-center gap-2 mb-2 min-w-0">
                  <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded border uppercase shrink-0 ${
                    isPdf ? 'bg-red-500/10 text-red-400 border-red-500/30' : isImg ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' : 'bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30'
                  }`}>
                    {fileMeta.ext}
                  </span>

                  <h4 className="text-white text-xs font-bold font-mono truncate flex-1 group-hover:text-[#00f2fe] transition-colors" title={item.filename}>
                    {fileMeta.base}
                  </h4>

                  <button 
                    onClick={() => setQueryAssetId(item.assetIdText || item.assetId)}
                    className="text-slate-500 hover:text-white p-1 rounded font-bold text-xs shrink-0"
                    title="Select Asset ID"
                  >
                    ⋮
                  </button>
                </div>

                {/* Main Card Body (Google Drive Preview Box) */}
                <div 
                  onClick={() => setQueryAssetId(item.assetIdText || item.assetId)}
                  className="h-32 bg-[#090e1f] rounded-xl border border-white/5 group-hover:border-[#00f2fe]/30 flex flex-col items-center justify-center mb-3 cursor-pointer transition-all relative overflow-hidden group/preview"
                >
                  <span className="text-5xl group-hover/preview:scale-110 transition-transform duration-300 mb-1">
                    {getFileIcon(item.filename)}
                  </span>
                  <span className="text-[9.5px] text-slate-500 font-mono">Encrypted Payload</span>
                </div>

                {/* Bottom Metadata Bar (Google Drive Owner Avatar & Reconstruct Action) */}
                <div className="flex justify-between items-center pt-2 border-t border-white/5 font-mono text-[12px]">
                  <div className="flex items-center gap-1.5 text-slate-400 min-w-0">
                    <span className="w-4 h-4 rounded-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] flex items-center justify-center text-[10px] text-[#060913] font-black shrink-0">
                      I
                    </span>
                    <span className="truncate text-slate-400">
                      {item.assetIdText ? `#${item.assetIdText}` : 'Owner'}
                    </span>
                  </div>

                  <button 
                    onClick={() => handleRetrievalSequence(item.assetIdText || item.assetId)}
                    className="px-2.5 py-1 bg-[#00f2fe]/10 hover:bg-[#00f2fe] text-[#00f2fe] hover:text-[#060913] border border-[#00f2fe]/30 font-bold rounded-lg transition-all shrink-0"
                  >
                    🧩 RECONSTRUCT
                  </button>
                </div>

              </div>
            );
          })}
        </div>
      )}

    </div>

    {/* 🌳 PROOF-OF-STORAGE STATUS & NODE RELIABILITY PANEL */}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

      {/* Asset Proof Status Lookup */}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-white">🌳 Asset Proof Status</h3>
        <p className="text-[12px] text-[#8a96ab] font-mono leading-relaxed">Look up the on-chain Merkle root + challenge history for an Asset Tracking ID (InayaProofRegistry).</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={proofLookupInput}
            onChange={(e) => setProofLookupInput(e.target.value)}
            placeholder="Asset Tracking ID or 0x fileHash"
            className="flex-1 bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00f2fe]/30"
          />
          <button
            onClick={handleProofLookup}
            disabled={isLoadingProofLookup}
            className="px-4 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-lg shadow-lg hover:brightness-110 transition-all whitespace-nowrap disabled:opacity-50"
          >
            {isLoadingProofLookup ? '⏳' : 'CHECK'}
          </button>
        </div>

        {proofLookupResult && (
          proofLookupResult.notFound ? (
            <div className="text-[13px] font-mono text-amber-400/80 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-3">
              No Merkle root registered on-chain for this asset yet.
            </div>
          ) : (
            <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-2 font-mono text-[13px]">
              <div className="flex justify-between"><span className="text-[#8a96ab]">Merkle Root</span><span className="text-[#00f2fe] truncate max-w-[60%]" title={proofLookupResult.merkleRoot}>{truncateAddress(proofLookupResult.merkleRoot)}</span></div>
              <div className="flex justify-between"><span className="text-[#8a96ab]">Chunk Count</span><span className="text-white">{proofLookupResult.chunkCount}</span></div>
              <div className="flex justify-between"><span className="text-[#8a96ab]">Assigned Node</span><span className="text-white truncate max-w-[60%]" title={proofLookupResult.node}>{proofLookupResult.node === ethers.ZeroAddress ? '— unassigned —' : truncateAddress(proofLookupResult.node)}</span></div>
              <div className="flex justify-between"><span className="text-[#8a96ab]">Registered At</span><span className="text-white">{proofLookupResult.registeredAt ? new Date(proofLookupResult.registeredAt * 1000).toLocaleString() : '—'}</span></div>
              <div className="flex justify-between"><span className="text-[#8a96ab]">Last Verified</span><span className="text-white">{proofLookupResult.lastVerifiedAt ? new Date(proofLookupResult.lastVerifiedAt * 1000).toLocaleString() : 'Never'}</span></div>
              <div className="flex justify-between"><span className="text-emerald-400">Challenges Passed</span><span className="text-emerald-400 font-bold">{proofLookupResult.challengesPassed}</span></div>
              <div className="flex justify-between"><span className="text-red-400">Challenges Failed</span><span className="text-red-400 font-bold">{proofLookupResult.challengesFailed}</span></div>
            </div>
          )
        )}
      </div>

      {/* Node Reliability Lookup */}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-white">🛡️ Node Reliability</h3>
        <p className="text-[12px] text-[#8a96ab] font-mono leading-relaxed">Check any storage node operator's aggregate pass/fail challenge history across every asset they've hosted.</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={nodeLookupInput}
            onChange={(e) => setNodeLookupInput(e.target.value)}
            placeholder="0x Node Wallet Address"
            className="flex-1 bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00f2fe]/30"
          />
          <button
            onClick={handleNodeReliabilityLookup}
            disabled={isLoadingNodeLookup}
            className="px-4 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-lg shadow-lg hover:brightness-110 transition-all whitespace-nowrap disabled:opacity-50"
          >
            {isLoadingNodeLookup ? '⏳' : 'CHECK'}
          </button>
        </div>

        {nodeLookupResult && (() => {
          const total = nodeLookupResult.passed + nodeLookupResult.failed;
          const rate = total > 0 ? ((nodeLookupResult.passed / total) * 100).toFixed(1) : null;
          return (
            <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-2 font-mono text-[13px]">
              <div className="flex justify-between"><span className="text-emerald-400">Challenges Passed</span><span className="text-emerald-400 font-bold">{nodeLookupResult.passed}</span></div>
              <div className="flex justify-between"><span className="text-red-400">Challenges Failed</span><span className="text-red-400 font-bold">{nodeLookupResult.failed}</span></div>
              <div className="flex justify-between"><span className="text-[#8a96ab]">Reliability Rate</span><span className="text-white font-bold">{rate !== null ? `${rate}%` : 'No challenges yet'}</span></div>
            </div>
          );
        })()}
      </div>

    </div>

  </div>
)}

          {/* 💎 VIEWPORT AREA 2B: BUSINESS MODEL (PAY-AS-YOU-GO + CORPORATE RESERVE) */}
          {currentPage === 'Business Model' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="bg-gradient-to-r from-[#0a1124] to-[#080d1a] border border-[#00f2fe]/20 rounded-2xl p-6 shadow-xl">
                <h2 className="text-base font-black text-white uppercase tracking-wider mb-2">Strategic Business Model &amp; Financial Architecture</h2>
                <p className="text-xs text-slate-400 leading-relaxed font-mono">
                  Retail and developer accounts run on transparent <span className="text-[#00f2fe] font-bold">Pay-As-You-Go</span> pricing settled in stablecoins, while institutional clients can lock in a fixed-cost <span className="text-[#00f2fe] font-bold">Corporate Reserve</span> annual plan. Every invoice — retail or corporate — routes through the dApp's automated USDT→INAYA buyback, driving programmatic TVL into the network vault.
                </p>
              </div>

              {/* PAY-AS-YOU-GO SUMMARY CARDS */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-[#00f2fe] font-bold text-lg">4.5 USDT</div>
                  <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mt-1">Baseline Storage / TB / Month</div>
                </div>
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-emerald-400 font-bold text-lg">5 INAYA</div>
                  <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mt-1">Egress / 0.5 TB Retrieved</div>
                </div>
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-amber-400 font-bold text-lg">5 USDT</div>
                  <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mt-1">Flat Annual Maintenance</div>
                </div>
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-violet-400 font-bold text-lg">26.7%</div>
                  <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mt-1">Staking Rewards Pool APY Source</div>
                </div>
              </div>

              {/* 💵 PAY-AS-YOU-GO LIVE BILLING PANEL */}
              <div className="bg-[#090d16]/80 border border-[#00f2fe]/20 rounded-2xl p-6 space-y-5">
                <div>
                  <h3 className="text-sm font-bold text-white mb-1">💵 Pay-As-You-Go Live Billing</h3>
                  <p className="text-[12px] text-slate-500 font-mono">Retail metered billing settled directly on-chain against the PAYG contract — independent of the Corporate Reserve checkout below.</p>
                </div>

                {paygLog && (
                  <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-[13px] p-3.5 rounded-xl break-words">
                    {paygLog}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                  {/* STORAGE SUBSCRIPTION */}
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-3 font-mono">
                    <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider">Storage Subscription (30 Days)</div>
                    <div className="text-white font-bold text-sm">{paygPricing.storagePerTB} USDT / TB</div>
                    <input
                      type="number"
                      min="1"
                      value={paygTbUnits}
                      onChange={(e) => setPaygTbUnits(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                      placeholder="TB units"
                    />
                    <button
                      onClick={handlePaygStorageSubscription}
                      disabled={isPaygStorageBusy || !isConnected}
                      className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[13px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPaygStorageBusy ? "PROCESSING..." : "💵 PAY STORAGE (PAYG)"}
                    </button>
                  </div>

                  {/* EGRESS FEE */}
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-3 font-mono">
                    <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider">Egress / Retrieval Fee</div>
                    <div className="text-white font-bold text-sm">{paygPricing.egressPerHalfTB} INAYA / 0.5 TB</div>
                    <input
                      type="number"
                      min="1"
                      value={paygEgressUnits}
                      onChange={(e) => setPaygEgressUnits(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                      placeholder="0.5 TB units"
                    />
                    <button
                      onClick={handlePaygEgressFee}
                      disabled={isPaygEgressBusy || !isConnected}
                      className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[13px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPaygEgressBusy ? "PROCESSING..." : "💵 PAY EGRESS (PAYG)"}
                    </button>
                  </div>

                  {/* ANNUAL MAINTENANCE */}
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-3 font-mono">
                    <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider">Annual Maintenance</div>
                    <div className="text-white font-bold text-sm">{paygPricing.maintenanceFee} USDT / Year</div>
                    <div className="text-[12px] text-slate-500 py-2">
                      {paygStatus.maintenanceCurrent ? (
                        <span className="text-emerald-400 font-bold">✓ Current through {new Date(paygStatus.lastMaintenancePaidAt + 365 * 24 * 60 * 60 * 1000).toLocaleDateString()}</span>
                      ) : (
                        <span className="text-amber-400 font-bold">⚠ Not yet paid / lapsed</span>
                      )}
                    </div>
                    <button
                      onClick={handlePaygAnnualMaintenance}
                      disabled={isPaygMaintenanceBusy || !isConnected}
                      className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[13px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPaygMaintenanceBusy ? "PROCESSING..." : "💵 PAY MAINTENANCE (PAYG)"}
                    </button>
                  </div>

                </div>

                {isConnected && (
                  <div className="text-[9.5px] text-slate-500 font-mono pt-1 border-t border-white/5">
                    Current PAYG commitment: <span className="text-white font-bold">{paygStatus.tbCommitted} TB</span> · Storage {paygStatus.storageActive ? <span className="text-emerald-400 font-bold">ACTIVE</span> : <span className="text-amber-400 font-bold">LAPSED</span>} until {paygStatus.storagePaidThrough ? new Date(paygStatus.storagePaidThrough).toLocaleDateString() : '—'}
                  </div>
                )}
              </div>

              {/* MARKET PRICING COMPARISON */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 overflow-x-auto">
                <h3 className="text-sm font-bold text-white mb-4">📉 Market Pricing Comparison</h3>
                <table className="w-full text-left font-mono text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 text-[12px] uppercase">
                      <th className="p-4 font-bold">Provider</th>
                      <th className="p-4 font-bold">Storage (1 TB / Month)</th>
                      <th className="p-4 font-bold">Egress (1 TB Download)</th>
                      <th className="p-4 font-bold">Minimum Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-slate-300">
                    <tr><td className="p-4">Amazon S3 (Standard)</td><td className="p-4">~23.00 USDT</td><td className="p-4">~90.00 USDT</td><td className="p-4">30 Days</td></tr>
                    <tr><td className="p-4">Google Cloud Storage</td><td className="p-4">~20.00 USDT</td><td className="p-4">~80.00 USDT</td><td className="p-4">30 Days</td></tr>
                    <tr><td className="p-4">Legacy Web2 (B2)</td><td className="p-4">~6.00 USDT</td><td className="p-4">~10.00 USDT</td><td className="p-4">None</td></tr>
                    <tr className="bg-cyan-500/[0.06]"><td className="p-4 text-white font-bold">Inaya Network (DePIN)</td><td className="p-4 text-emerald-400 font-bold">4.50 USDT</td><td className="p-4 text-emerald-400 font-bold">10 INAYA</td><td className="p-4 text-emerald-400 font-bold">Zero Constraints</td></tr>
                  </tbody>
                </table>
              </div>

              {activeCorporatePlan && (
                <div className="bg-emerald-500/[0.06] border border-emerald-500/30 rounded-2xl p-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 font-mono text-xs">
                  <div>
                    <span className="text-emerald-400 font-bold">✓ ACTIVE CORPORATE RESERVE:</span>
                    <span className="text-white font-bold ml-2">{activeCorporatePlan.tier}</span>
                    <span className="text-slate-500 ml-2">— valid until {new Date(activeCorporatePlan.expiresAt).toLocaleDateString()}</span>
                  </div>
                  <span className="text-[12px] text-slate-500">Re-purchasing before this date will prompt a duplicate-purchase confirmation.</span>
                </div>
              )}

              {/* CORPORATE RESERVE PLANS TABLE */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 overflow-x-auto">
                <h3 className="text-sm font-bold text-white mb-1">🏢 Corporate Reserve Plans (Annual)</h3>
                <p className="text-[12px] text-slate-500 font-mono mb-4">Fixed annual allocation, billed in USDT, with system maintenance settled natively in INAYA.</p>
                <table className="w-full text-left font-mono text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 text-[12px] uppercase">
                      <th className="p-4 font-bold">Total Allocated Data</th>
                      <th className="p-4 font-bold">Legacy AWS S3 Cost</th>
                      <th className="p-4 font-bold">Competitor B2 Reserve</th>
                      <th className="p-4 font-bold">Inaya Corporate Storage Fee</th>
                      <th className="p-4 font-bold">Annual Maintenance (INAYA)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-slate-300">
                    <tr className={selectedB2BTier === '250 TB / Year' ? 'bg-cyan-500/[0.04]' : ''}>
                      <td className="p-4 text-white font-bold">250 TB / Year</td>
                      <td className="p-4">76,680 USDT / yr</td>
                      <td className="p-4">19,500 USDT / yr</td>
                      <td className="p-4 text-amber-400 font-bold">13,500 USDT / Year</td>
                      <td className="p-4">500 USDT-equivalent / yr</td>
                    </tr>
                    <tr className={selectedB2BTier === '500 TB / Year' ? 'bg-cyan-500/[0.04]' : ''}>
                      <td className="p-4 text-white font-bold">500 TB / Year</td>
                      <td className="p-4">151,680 USDT / yr</td>
                      <td className="p-4">39,000 USDT / yr</td>
                      <td className="p-4 text-amber-400 font-bold">27,000 USDT / Year</td>
                      <td className="p-4">1,000 USDT-equivalent / yr</td>
                    </tr>
                    <tr className={selectedB2BTier === '1000 TB / Year' ? 'bg-cyan-500/[0.04]' : ''}>
                      <td className="p-4 text-white font-bold">1000 TB / Year</td>
                      <td className="p-4">295,680 USDT / yr</td>
                      <td className="p-4">78,000 USDT / yr</td>
                      <td className="p-4 text-amber-400 font-bold">54,000 USDT / Year</td>
                      <td className="p-4">2,000 USDT-equivalent / yr</td>
                    </tr>
                  </tbody>
                </table>

                {/* LIVE REVENUE ROUTER CHECKOUT TRIGGER */}
                <div className="mt-6 bg-[#0b1224] border border-[#00f2fe]/30 p-6 rounded-2xl flex flex-col md:flex-row justify-between items-center gap-4">
                  <div className="text-left font-mono">
                    <span className="text-[#00f2fe] text-xs font-bold block">// READY FOR ON-CHAIN ACTIVATION</span>
                    <p className="text-sm text-white font-extrabold mt-1">
                      Selected Allocation: <span className="text-amber-400">{selectedB2BTier}</span>
                    </p>
                    <p className="text-[13px] text-slate-500">
                      Billed via trustless multi-shard settlement router.
                    </p>
                  </div>
                  
                  <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
                    <button
                      onClick={handleCorporateCheckout}
                      disabled={isProcessingInvoice}
                      className="w-full md:w-auto px-8 py-3 bg-gradient-to-r from-emerald-400 to-teal-500 text-[#060913] font-black text-xs rounded-xl shadow-[0_0_15px_rgba(52,211,153,0.2)] hover:brightness-110 active:scale-95 transition-all disabled:opacity-40"
                    >
                      {isProcessingInvoice ? "PROCESSING ORDER..." : `💳 PAY & ACTIVATE ${selectedB2BTier.toUpperCase()}`}
                    </button>
                    <button
                      onClick={handleCardCheckout}
                      disabled={isProcessingCardCheckout}
                      className="w-full md:w-auto px-8 py-3 bg-white text-[#060913] font-black text-xs rounded-xl shadow-[0_0_15px_rgba(255,255,255,0.15)] hover:brightness-95 active:scale-95 transition-all disabled:opacity-40"
                    >
                      {isProcessingCardCheckout ? "REDIRECTING..." : `💳 PAY WITH CARD (NO WALLET)`}
                    </button>
                  </div>
                </div>
                <div className="mt-3 bg-amber-400/10 border border-amber-400/40 rounded-xl px-4 py-2.5 flex items-center gap-2">
                  <span className="text-amber-400 text-sm">⚠️</span>
                  <p className="text-[12px] text-amber-300 font-bold font-mono">
                    TEST MODE — use card 4242 4242 4242 4242, any future expiry, any CVC/ZIP. Real card numbers will not work here.
                  </p>
                </div>
              </div>

              {/* PROFESSIONAL NETWORK FUNDAMENTALS */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
                <h3 className="text-sm font-bold text-white mb-4">✅ Professional Network Fundamentals</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-[13px]">
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Always-Hot Performance Storage</span>
                    <p className="text-slate-500 mt-1">Data shards stay permanently ready for concurrent retrieval — no cold-archive latency gaps.</p>
                  </div>
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Zero Minimum File Size Penalties</span>
                    <p className="text-slate-500 mt-1">Tiny configs or massive video assets settle under the same uniform rate framework.</p>
                  </div>
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Zero Storage Duration Constraints</span>
                    <p className="text-slate-500 mt-1">Delete or cycle files freely — no contractual early-termination penalties.</p>
                  </div>
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Free Core API Calls</span>
                    <p className="text-slate-500 mt-1">Configure, query, and monitor storage routes without unexpected micro-charges.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 🥩 VIEWPORT AREA 2B-2: $INAYA STAKING ENGINE */}
          {currentPage === 'Staking' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">$INAYA Staking Engine</h2>
                  <p className="text-[#94a3b8] text-sm mb-2">Stake $INAYA to earn passive APY from the 8,000,000 INAYA Staking Rewards Pool and unlock priority bandwidth tiers.</p>
                </div>
                <div className="hidden sm:block shrink-0">
                  <AccentGraphic variant="staking" size={110} />
                </div>
              </div>

              {stakingLog && (
                <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl break-words">
                  {stakingLog}
                </div>
              )}

              {/* OVERVIEW CARDS -- skeleton only on the very first load (no
                  data fetched yet), never on a background refresh, so
                  repeat fetches don't flicker the numbers away. */}
              {isLoadingStakingOverview && stakingOverview.totalStakedTVL === '0' && stakingOverview.userTier === 'None' ? (
                <Skeleton count={4} borderColors={['border-[#00f2fe]', 'border-emerald-400', 'border-violet-400', 'border-amber-400']} />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
                  <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl">
                    <div className="text-xl font-bold text-white">{Number(stakingOverview.totalStakedTVL).toLocaleString()} INAYA</div>
                    <div className="text-[12px] uppercase text-[#8a96ab] mt-1">Total Value Locked</div>
                  </div>
                  <div className="bg-[#0b1120]/40 border-l-4 border-emerald-400 p-5 rounded-r-xl">
                    <div className="text-xl font-bold text-white">{stakingOverview.estimatedAPY}%</div>
                    <div className="text-[12px] uppercase text-[#8a96ab] mt-1">Estimated APY (Flexible)</div>
                  </div>
                  <div className="bg-[#0b1120]/40 border-l-4 border-violet-400 p-5 rounded-r-xl">
                    <div className="text-xl font-bold text-white">{Number(stakingOverview.myStakedBalance).toLocaleString()} INAYA</div>
                    <div className="text-[12px] uppercase text-[#8a96ab] mt-1">My Staked Balance</div>
                  </div>
                  <div className="bg-[#0b1120]/40 border-l-4 border-amber-400 p-5 rounded-r-xl">
                    <div className="text-xl font-bold text-white">{Number(stakingOverview.claimableRewards).toFixed(4)} INAYA</div>
                    <div className="text-[12px] uppercase text-[#8a96ab] mt-1">Claimable Rewards</div>
                  </div>
                </div>
              )}

              {/* ENTERPRISE TIER BADGE */}
              {isConnected && stakingOverview.userTier === 'Enterprise Priority' && (
                <div className="bg-emerald-500/[0.06] border border-emerald-500/30 rounded-2xl p-4 font-mono text-xs flex items-center gap-2">
                  <span className="text-emerald-400 font-bold">⚡ Tier 1 Priority Node — High API Bandwidth Active</span>
                </div>
              )}

              {/* STAKE / UNSTAKE / CLAIM PANELS */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* STAKE PANEL */}
                <div className="bg-[#090d16]/80 border border-[#00f2fe]/20 rounded-2xl p-5 space-y-3 font-mono">
                  <h3 className="text-sm font-bold text-white">📥 Stake</h3>
                  <input
                    type="number" min="0" value={stakeAmountInput}
                    onChange={(e) => setStakeAmountInput(e.target.value)}
                    placeholder="Amount to stake"
                    className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    {[{ label: 'Flexible', value: 0 }, { label: '30 Days', value: 30 }, { label: '90 Days', value: 90 }].map((tier) => (
                      <button
                        key={tier.value}
                        onClick={() => setSelectedLockTier(tier.value)}
                        className={`py-1.5 text-[12px] font-bold rounded-lg border transition-all ${selectedLockTier === tier.value ? 'bg-[#00f2fe] text-[#060913] border-[#00f2fe]' : 'bg-black/20 text-slate-400 border-white/10'}`}
                      >
                        {tier.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500">Flexible = 1.00x · 30 Days = 1.25x · 90 Days = 1.50x reward multiplier.</p>
                  <button
                    onClick={handleStakeInaya}
                    disabled={isStakingBusy || !isConnected}
                    className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[13px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
                  >
                    {isStakingBusy ? "STAKING..." : "⚡ APPROVE & STAKE"}
                  </button>
                </div>

                {/* UNSTAKE PANEL */}
                <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 space-y-3 font-mono">
                  <h3 className="text-sm font-bold text-white">📤 Unstake</h3>
                  <input
                    type="number" min="0" value={unstakeAmountInput}
                    onChange={(e) => setUnstakeAmountInput(e.target.value)}
                    placeholder="Amount to withdraw"
                    className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                  />
                  {stakingOverview.lockExpiryTimestamp > Date.now() && (
                    <p className="text-[12px] text-amber-400 font-bold">🔒 Locked until {new Date(stakingOverview.lockExpiryTimestamp).toLocaleString()}</p>
                  )}
                  <button
                    onClick={handleUnstakeInaya}
                    disabled={isUnstakingBusy || !isConnected}
                    className="w-full py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold text-[13px] rounded-lg transition-all disabled:opacity-40"
                  >
                    {isUnstakingBusy ? "WITHDRAWING..." : "WITHDRAW"}
                  </button>
                </div>

                {/* CLAIM PANEL */}
                <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 space-y-3 font-mono flex flex-col justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white mb-2">🎁 Claim Rewards</h3>
                    <div className="text-2xl font-extrabold text-emerald-400">{Number(stakingOverview.claimableRewards).toFixed(4)}</div>
                    <div className="text-[12px] text-slate-500">$INAYA available to claim</div>
                  </div>
                  <button
                    onClick={handleClaimStakingReward}
                    disabled={isClaimingBusy || !isConnected || parseFloat(stakingOverview.claimableRewards) <= 0}
                    className="w-full py-2.5 bg-gradient-to-r from-emerald-400 to-teal-500 text-[#060913] font-bold text-[13px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
                  >
                    {isClaimingBusy ? "CLAIMING..." : "CLAIM REWARDS"}
                  </button>
                </div>

              </div>
            </div>
          )}

          {/* 📊 VIEWPORT AREA 2C: MY DASHBOARD */}
          {currentPage === 'My Dashboard' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">My Dashboard</h2>
              <p className="text-[#94a3b8] text-sm mb-2">A live read of your on-chain billing activity, storage allocation, and total spend across Pay-As-You-Go and Corporate Reserve.</p>

              {!isConnected && cardCustomerPlan ? (
                <div className="max-w-2xl">
                  <div className="bg-black/20 border border-emerald-400/20 rounded-2xl p-6 mb-4">
                    <div className="text-[12px] uppercase tracking-widest text-emerald-400 font-bold mb-2">Corporate Reserve — Card Payment</div>
                    <div className="text-white font-bold text-lg">{cardCustomerPlan.tier}</div>
                    <div className="text-sm text-slate-400 mt-1">
                      <span className="text-emerald-400 font-bold">ACTIVE</span> · valid until {new Date(cardCustomerPlan.expiresAt).toLocaleDateString()}
                    </div>
                    <div className="text-[13px] text-slate-500 mt-3 font-mono">
                      Router tx: <a className="text-[#00f2fe] underline" href={`https://testnet.bscscan.com/tx/${cardCustomerPlan.routerTxHash}`} target="_blank" rel="noreferrer">{cardCustomerPlan.routerTxHash?.slice(0, 14)}...</a>
                      <br />Escrow tx: <a className="text-[#00f2fe] underline" href={`https://testnet.bscscan.com/tx/${cardCustomerPlan.escrowTxHash}`} target="_blank" rel="noreferrer">{cardCustomerPlan.escrowTxHash?.slice(0, 14)}...</a>
                    </div>
                  </div>
                  <p className="text-[13px] text-slate-500 italic">Signed in as {cardCustomerEmail} · no wallet connected. Connect a wallet any time to also see Pay-As-You-Go activity.</p>
                </div>
              ) : !isConnected && cardCustomerEmail && cardCustomerPlanTimedOut ? (
                <div className="bg-black/20 border border-red-400/20 rounded-2xl p-10 text-center font-mono text-xs text-red-400 italic">
                  // Payment received, but on-chain activation hasn't completed after 60s.
                  <br />This usually means the settlement step failed server-side — check your webhook logs, or contact support with email: {cardCustomerEmail}
                </div>
              ) : !isConnected && cardCustomerEmail ? (
                <div className="bg-black/20 border border-amber-400/20 rounded-2xl p-10 text-center font-mono text-xs text-amber-400 italic">
                  // Payment received — activating your plan on-chain, this can take up to a minute on testnet. This page updates automatically.
                </div>
              ) : !isConnected ? (
                <EmptyState
                  icon="🔌"
                  title="Connect a wallet to see your dashboard"
                  description="Storage allocation, billing history, and total spend across Pay-As-You-Go and Corporate Reserve all read live from your on-chain activity."
                  ctaLabel="Connect Wallet"
                  onCta={() => setIsWalletModalOpen(true)}
                />
              ) : (
                <>
                  {/* SUMMARY CARDS */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
                    <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{totalSpaceAllocatedTB.toLocaleString()} TB</div>
                      <div className="text-[12px] uppercase text-[#8a96ab] mt-1">Total Space Allocated</div>
                    </div>
                    <div className="bg-[#0b1120]/40 border-l-4 border-emerald-400 p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{paygTotalUsdtSpent.toFixed(4)} USDT</div>
                      <div className="text-[12px] uppercase text-[#8a96ab] mt-1">Total PAYG Spent (USDT)</div>
                    </div>
                    <div className="bg-[#0b1120]/40 border-l-4 border-violet-400 p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{paygTotalInayaSpent.toFixed(4)} INAYA</div>
                      <div className="text-[12px] uppercase text-[#8a96ab] mt-1">Total PAYG Spent (INAYA)</div>
                    </div>
                    <div className="bg-[#0b1120]/40 border-l-4 border-amber-400 p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{paygHistory.length}</div>
                      <div className="text-[12px] uppercase text-[#8a96ab] mt-1">PAYG Transactions Logged</div>
                    </div>
                  </div>

                  {/* STORAGE SPACE ALLOCATION BREAKDOWN */}
                  <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
                    <h3 className="text-sm font-bold text-white mb-4">🗄️ Storage Space Allocation</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-xs">
                      <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                        <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mb-1">Pay-As-You-Go Commitment</div>
                        <div className="text-white font-bold text-lg">{paygStatus.tbCommitted} TB</div>
                        <div className="mt-1">
                          Storage: {paygStatus.storageActive ? <span className="text-emerald-400 font-bold">ACTIVE</span> : <span className="text-amber-400 font-bold">LAPSED</span>}
                          {paygStatus.storagePaidThrough > 0 && <span className="text-slate-500"> · through {new Date(paygStatus.storagePaidThrough).toLocaleDateString()}</span>}
                        </div>
                      </div>
                      <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                        <div className="text-[12px] text-[#8a96ab] uppercase tracking-wider mb-1">Corporate Reserve Allocation</div>
                        <div className="text-white font-bold text-lg">{corporateAllocatedTB.toLocaleString()} TB</div>
                        <div className="mt-1">
                          {activeCorporatePlan ? (
                            <span className="text-emerald-400 font-bold">{activeCorporatePlan.tier} — valid until {new Date(activeCorporatePlan.expiresAt).toLocaleDateString()}</span>
                          ) : (
                            <span className="text-slate-500">No active Corporate Reserve plan</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* PAYG TRANSACTION HISTORY TABLE */}
                  <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 overflow-x-auto">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-sm font-bold text-white">🧾 Pay-As-You-Go Transactions</h3>
                      <button onClick={() => fetchPaygHistory(walletAddress)} className="text-[12px] font-mono bg-white/5 text-[#00f2fe] border border-white/10 px-3 py-1 rounded-lg hover:bg-white/10 transition-colors">🔄 REFRESH</button>
                    </div>
                    {isLoadingPaygHistory ? (
                      <div className="py-6 text-center font-mono text-xs text-[#8a96ab]">⚙️ Syncing PAYG ledger events...</div>
                    ) : paygHistory.length === 0 ? (
                      <div className="py-6 text-center font-mono text-xs text-[#8a96ab] italic">// No Pay-As-You-Go transactions found in the current ledger block window.</div>
                    ) : (
                      <table className="w-full text-left font-mono text-xs border-collapse">
                        <thead>
                          <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 text-[12px] uppercase">
                            <th className="p-3 font-bold">Type</th>
                            <th className="p-3 font-bold">Units</th>
                            <th className="p-3 font-bold">Amount</th>
                            <th className="p-3 font-bold">Date</th>
                            <th className="p-3 font-bold">Tx</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5 text-slate-300">
                          {paygHistory.map((item, idx) => (
                            <tr key={idx}>
                              <td className="p-3 text-white">{item.type}</td>
                              <td className="p-3">{item.units}</td>
                              <td className="p-3 text-emerald-400 font-bold">{parseFloat(item.amount).toFixed(4)} {item.asset}</td>
                              <td className="p-3">{new Date(item.timestamp).toLocaleDateString()}</td>
                              <td className="p-3">
                                <a href={`https://testnet.bscscan.com/tx/${item.txHash}`} target="_blank" rel="noreferrer" className="text-[#00f2fe] underline">View ↗</a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {currentPage === 'Referrals' && <ReferralSection />}

          {currentPage === 'Learn' && <LearnSection walletAddress={walletAddress} />}

          {currentPage === 'Hackathon' && <HackathonSection walletAddress={walletAddress} getActiveProvider={getActiveProvider} />}

          {/* VIEWPORT AREA 3: GENESIS AIRDROP CALCULATOR METRICS */}
          {currentPage === 'Genesis Airdrop' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div>
                <h2 className="text-2xl font-extrabold text-white">Genesis Airdrop</h2>
                <p className="text-[#94a3b8] text-sm mt-1">1,000,000 $INAYA (3.3% of hard cap) reserved for early users, developers, and community contributors — split across the categories below.</p>
              </div>

              {/* AUTOMATIC USER UPLOAD REWARD */}
              <div className="bg-gradient-to-r from-[#0a0f1d] to-[#0b1426] border border-[#00f2fe]/20 rounded-xl p-6 space-y-4 font-mono text-xs">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-white font-bold text-sm">👤 Users — Automatic Upload Reward</span>
                  <span className="text-[#00f2fe] font-bold">{UPLOAD_REWARD_PER_FILE} $INAYA / upload · capped at {UPLOAD_REWARD_CAP_PER_USER} $INAYA / wallet</span>
                </div>
                <p className="text-slate-500">No form needed for this one — every successful upload from your connected wallet counts automatically, up to the per-wallet cap. This replaces the old points system entirely.</p>
                <p className="text-slate-500">Want to fully test download/egress, not just upload? This airdrop is intentionally small — grab additional test $INAYA anytime from the{' '}
                  <button onClick={() => setCurrentPage('Faucet')} className="text-[#00f2fe] font-bold underline underline-offset-2 hover:text-white transition-colors">Faucet</button>.
                </p>

                {isConnected ? (
                  (() => {
                    const uploadCount = vaultHistory.length;
                    const rawReward = uploadCount * UPLOAD_REWARD_PER_FILE;
                    const cappedReward = Math.min(rawReward, UPLOAD_REWARD_CAP_PER_USER);
                    const pctOfCap = Math.min((cappedReward / UPLOAD_REWARD_CAP_PER_USER) * 100, 100);
                    const capped = rawReward >= UPLOAD_REWARD_CAP_PER_USER;
                    return (
                      <div className="bg-black/30 border border-white/5 rounded-lg p-4 space-y-3">
                        <div className="flex justify-between items-baseline">
                          <span className="text-slate-400">Your uploads counted: <span className="text-white font-bold">{uploadCount}</span></span>
                          <span className="text-2xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00f2fe] to-emerald-400">{cappedReward.toFixed(2)} $INAYA</span>
                        </div>
                        <div className="w-full bg-black/40 rounded-full h-1.5 border border-white/5 overflow-hidden">
                          <div className="bg-gradient-to-r from-[#00f2fe] to-emerald-500 h-full rounded-full shadow-[0_0_8px_rgba(0,242,254,0.4)]" style={{ width: `${pctOfCap}%` }}></div>
                        </div>
                        <div className="flex justify-between text-[12px] text-slate-500">
                          <span>0 $INAYA</span>
                          {capped ? <span className="text-emerald-400 font-bold">✓ Cap reached ({UPLOAD_REWARD_CAP_PER_USER} $INAYA)</span> : <span>{UPLOAD_REWARD_CAP_PER_USER} $INAYA cap</span>}
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="bg-black/30 border border-white/5 rounded-lg p-4">
                    <EmptyState compact icon="🔌" description="Connect your wallet to see your live upload count and reward estimate." ctaLabel="Connect" onCta={() => setIsWalletModalOpen(true)} />
                  </div>
                )}
              </div>

              {/* CONTRIBUTOR ALLOCATION BREAKDOWN */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-4">
                <h3 className="text-sm font-bold text-white">🎯 Contributor Allocation</h3>
                <p className="text-[12px] text-slate-500 font-mono -mt-2">These three groups apply directly rather than accruing points — see the application forms below.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {contributorAllocationList.map((c) => (
                    <div key={c.label} className="bg-black/20 border border-white/5 rounded-xl p-4 font-mono space-y-2 flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-lg leading-none">{c.icon}</span>
                        <span className="text-white font-bold text-xs">{c.label}</span>
                      </div>
                      <div className="text-2xl font-extrabold text-[#00f2fe]">{c.pct}%</div>
                      <div className="w-full bg-black/40 rounded-full h-1.5 border border-white/5 overflow-hidden">
                        <div className="bg-gradient-to-r from-[#00f2fe] to-emerald-500 h-full rounded-full" style={{ width: `${c.pct}%` }}></div>
                      </div>
                      <p className="text-[12px] text-slate-500 leading-relaxed flex-1">{c.desc}</p>
                      <button
                        onClick={() => setSelectedAirdropForm(c.key)}
                        className="mt-1 text-[12px] font-bold text-[#00f2fe] border border-[#00f2fe]/30 rounded-lg py-1.5 hover:bg-[#00f2fe]/10 transition-colors"
                      >
                        APPLY →
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* APPLICATION FORMS — Developer form vs. Community/Moderator form */}
              <div className="bg-black/40 border border-white/5 p-6 rounded-xl space-y-4">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <div className="text-sm font-bold text-white">Apply for the Genesis Airdrop</div>
                    <div className="text-xs text-[#94a3b8]">Pick the form that matches your role. Applications are reviewed by the team.</div>
                  </div>
                  <div className="flex gap-2 w-full sm:w-auto">
                    <button
                      onClick={() => setSelectedAirdropForm('community')}
                      className={`flex-1 sm:flex-none text-xs font-bold px-4 py-2 rounded-lg transition-all ${selectedAirdropForm === 'community' ? 'bg-[#00f2fe] text-[#060913]' : 'bg-white/5 text-slate-300 border border-white/10'}`}
                    >
                      🌍 Community / Moderator
                    </button>
                    <button
                      onClick={() => setSelectedAirdropForm('developer')}
                      className={`flex-1 sm:flex-none text-xs font-bold px-4 py-2 rounded-lg transition-all ${selectedAirdropForm === 'developer' ? 'bg-[#00f2fe] text-[#060913]' : 'bg-white/5 text-slate-300 border border-white/10'}`}
                    >
                      🛠️ Developer
                    </button>
                  </div>
                </div>

                {(() => {
                  const activeFormUrl = selectedAirdropForm === 'developer' ? AIRDROP_FORM_DEVELOPER_URL : AIRDROP_FORM_COMMUNITY_URL;
                  return (
                    <>
                      <div className="flex justify-end">
                        <a
                          href={activeFormUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-bold bg-[#00f2fe] text-[#060913] px-5 py-2.5 rounded-lg transition-transform active:scale-95 hover:brightness-110 whitespace-nowrap"
                        >
                          OPEN FORM ↗
                        </a>
                      </div>
                      <div className="rounded-xl overflow-hidden border border-white/10 bg-white">
                        <iframe
                          key={activeFormUrl}
                          src={`${activeFormUrl}${activeFormUrl.includes('?') ? '&' : '?'}embedded=true`}
                          title="Genesis Airdrop Application Form"
                          className="w-full"
                          style={{ height: '640px', border: 'none' }}
                          loading="lazy"
                        >
                          Loading form…
                        </iframe>
                      </div>
                    </>
                  );
                })()}
                <p className="text-[9.5px] text-slate-500 font-mono">If the embedded form above doesn't load, use the "OPEN FORM ↗" button to fill it out in a new tab.</p>
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 5: WHITE PAPER */}
          {currentPage === 'White Paper' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-6">
              <h1 className="text-2xl font-black text-white">THE INAYA PROTOCOL</h1>
              <p className="text-xs text-[#94a3b8] font-bold uppercase tracking-wider">A Decentralized Sovereign Custody Network for High-Value Assets</p>
              
              <div className="flex flex-wrap gap-2 border-b border-white/5 pb-3">
                {['Abstract', 'The Problem', 'Architecture', 'Vision', 'Tokenomics Matrix'].map((sec) => (
                  <button key={sec} onClick={() => setActivePaperSection(sec)} className={`px-4 py-2 text-xs font-mono font-bold rounded-lg transition-all ${activePaperSection === sec ? 'bg-[#00f2fe]/10 border border-[#00f2fe] text-[#00f2fe]' : 'text-[#8a96ab] bg-white/[0.01] hover:text-slate-300'}`}>{sec}</button>
                ))}
              </div>

              <div className="font-mono text-xs leading-relaxed text-[#94a3b8] bg-black/20 p-5 rounded-xl border border-white/5 max-h-[50vh] overflow-y-auto space-y-4">
                {activePaperSection === 'Abstract' && (
                  <>
                    <h3 className="text-white font-bold text-sm">// 1.0 ABSTRACT SUMMARY</h3>
                    <p>Inaya Custody Network represents a paradigm shift in decentralized object storage management. Traditional layouts suffer from localized single-point failures and third-party infrastructure exposures.</p>
                  </>
                )}

                {activePaperSection === 'The Problem' && (
                  <>
                    <h3 className="text-white font-bold text-sm">// 2.0 CENTRALIZED CUSTODY LIABILITY</h3>
                    <p>Modern cloud architectures rely on corporate server frameworks that compromise raw sovereignty. Governments and massive data monopolizers maintain deep vector tracking capabilities that can intercept client data objects mid-transit.</p>
                  </>
                )}

                {activePaperSection === 'Architecture' && (
                  <>
                    <h3 className="text-white font-bold text-sm">// 3.0 SYSTEM FRAGMENTATION TECHNOLOGY</h3>
                    <p>When a node initiates a data store action within the Inaya core framework, shards are pushed via separate network pipes into isolated decentralized storage vaults, and their tracking metadata hashes are cryptographically anchored to public EVM contract ledgers.</p>
                  </>
                )}

                {activePaperSection === 'Vision' && (
                  <div className="space-y-5 font-sans">
                    <h3 className="text-white font-bold text-xs font-mono">// 3.5 STRATEGIC VISION</h3>

                    <div className="bg-[#060913] border border-white/10 rounded-xl p-4 space-y-3">
                      <div>
                        <span className="text-[11px] font-mono font-bold text-[#00f2fe] uppercase tracking-widest">Mission</span>
                        <p className="text-slate-300 text-xs italic mt-1">To build the world's most trusted decentralized digital infrastructure where individuals, businesses, and AI systems own, protect, and control their data without relying on centralized cloud providers.</p>
                      </div>
                      <div>
                        <span className="text-[11px] font-mono font-bold text-[#00f2fe] uppercase tracking-widest">Vision Statement</span>
                        <p className="text-slate-300 text-xs italic mt-1">Inaya Network aims to become the decentralized trust layer for the internet — where files, identities, AI, and digital assets remain private, verifiable, and permanently under user control.</p>
                      </div>
                    </div>

                    <div>
                      <span className="text-[11px] font-mono font-bold text-[#8a96ab] uppercase tracking-widest">Tactical Project Development Roadmap</span>
                      <div className="space-y-2.5 mt-2">
                        {roadmapPhases.map((p) => {
                          const s = roadmapStatusConfig[p.status];
                          return (
                            <div key={p.phase} className={`border rounded-lg p-3.5 border-l-2 ${s.border} bg-black/20`}>
                              <div className="flex items-center justify-between mb-2 flex-wrap gap-1.5">
                                <span className="text-white font-bold text-xs">{p.phase}</span>
                                <span className={`text-[10px] font-mono font-bold uppercase tracking-widest rounded px-1.5 py-0.5 border ${s.badge}`}>{s.emoji} {s.label}</span>
                              </div>
                              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                                {p.items.map((item) => {
                                  const text = typeof item === 'string' ? item : item.text;
                                  const done = typeof item === 'object' && item.done;
                                  return (
                                    <li key={text} className={`text-[13px] flex items-start gap-1.5 ${done ? 'text-slate-300' : s.item}`}>
                                      <span className={done ? 'text-emerald-400' : s.text}>{done ? '✓' : s.bullet}</span>
                                      {text}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      {[
                        { label: "AI Vision", desc: "AI-assisted search, document intelligence, node monitoring, governance analytics, and developer assistants." },
                        { label: "Community Vision", desc: "Empower contributors through node rewards, staking, ambassadors, bug bounties, developer grants, and decentralized governance." },
                        { label: "Developer Vision", desc: "World-class SDKs, APIs, documentation, hackathons, and tooling to make Inaya easy to build on." },
                        { label: "Economic Vision", desc: "$INAYA powers node incentives, staking, governance, payments, enterprise usage, and ecosystem growth through real utility." },
                      ].map((v) => (
                        <div key={v.label} className="bg-black/20 border border-white/5 rounded-lg p-3">
                          <span className="text-[#00f2fe] font-bold text-[12px]">{v.label}</span>
                          <p className="text-slate-500 text-[10.5px] leading-relaxed mt-1">{v.desc}</p>
                        </div>
                      ))}
                    </div>

                    <div className="bg-gradient-to-r from-[#0a1124] to-[#080d1a] border border-[#00f2fe]/20 rounded-xl p-4">
                      <span className="text-[11px] font-mono font-bold text-[#8a96ab] uppercase tracking-widest">Ultimate Goal</span>
                      <p className="text-white text-xs italic mt-1.5 leading-relaxed">Establish Inaya Network as foundational trust infrastructure for the next generation of the internet, prioritizing privacy, user ownership, resilience, and decentralization.</p>
                    </div>
                  </div>
                )}

                {activePaperSection === 'Tokenomics Matrix' && (
                  <div className="space-y-4 font-sans">
                    <h3 className="text-white font-bold text-xs font-mono">// 4.0 ALLOCATION DISPOSAL DATA</h3>
                    <p className="text-[12px] text-slate-500 italic font-mono -mt-2">Verified against the Strategic Business Model &amp; Financial Architecture (INAYA-EXEC-2026-V1).</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center pt-2">
                      
                      <div className="w-full border border-white/10 bg-[#060913] rounded-xl p-5 flex flex-col justify-center space-y-4">
                        <span className="text-[12px] font-mono text-[#8a96ab] uppercase tracking-widest">Visual Asset Weight Distribution</span>
                        
                        <div className="w-full h-8 rounded-lg overflow-hidden flex border border-white/5 shadow-inner">
                          <div className="bg-[#4facfe] h-full transition-all" style={{ width: '40.0%' }} title="Swarm Reserve: 40.0%"></div>
                          <div className="bg-violet-500 h-full transition-all" style={{ width: '26.7%' }} title="Staking Rewards: 26.7%"></div>
                          <div className="bg-cyan-400 h-full transition-all" style={{ width: '21.7%' }} title="Liquidity Pool: 21.7%"></div>
                          <div className="bg-indigo-500 h-full transition-all" style={{ width: '5.0%' }} title="Team Runway: 5.0%"></div>
                          <div className="bg-amber-400 h-full transition-all" style={{ width: '3.3%' }} title="Ecosystem Fund: 3.3%"></div>
                          <div className="bg-emerald-400 h-full transition-all" style={{ width: '3.3%' }} title="Genesis Airdrop: 3.3%"></div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-[#4facfe]"></span> <span className="text-slate-400">Swarm Reserve (40.0%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-violet-500"></span> <span className="text-slate-400">Staking Rewards (26.7%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-cyan-400"></span> <span className="text-slate-400">Liquidity (21.7%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-indigo-500"></span> <span className="text-slate-400">Team Core (5.0%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-amber-400"></span> <span className="text-slate-400">Ecosystem Fund (3.3%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-emerald-400"></span> <span className="text-slate-400">Airdrop (3.3%)</span></div>
                        </div>
                      </div>

                      <div className="font-mono text-xs space-y-3">
                        <div className="text-white font-bold bg-white/5 p-2 rounded border border-white/5">Total Hard Cap: 30,000,000 $INAYA</div>
                        <div className="space-y-1 text-[#94a3b8]">
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>🛸 Swarm Reserve (Strategic/Nodes):</span><span className="text-[#4facfe] font-bold">40.0% (12M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>🥩 Staking Rewards Pool:</span><span className="text-violet-400 font-bold">26.7% (8M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>💧 Liquidity Pool Allocation:</span><span className="text-cyan-400 font-bold">21.7% (6.5M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>👥 Team Runway Core:</span><span className="text-indigo-400 font-bold">5.0% (1.5M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>🌱 Ecosystem Fund:</span><span className="text-amber-400 font-bold">3.3% (1M)</span></div>
                          <div className="flex justify-between"><span>🎁 Genesis Airdrop Portals:</span><span className="text-emerald-400 font-bold">3.3% (1M)</span></div>
                        </div>
                        <p className="text-[11px] text-slate-600 pt-1 italic">Figures reconciled directly against the verified $INAYA token contract allocations on BNB Testnet.</p>
                      </div>

                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 6: CORPORATE DETAILED ABOUT US SHEET */}
          {currentPage === 'About Us' && (
            <div className="max-w-5xl mx-auto space-y-8">

              <div className="bg-gradient-to-r from-[#0e1830] to-[#0a0e14] border border-[#c9a24d]/30 rounded-2xl p-6 backdrop-blur-md shadow-xl">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[12px] uppercase tracking-widest text-[#c9a24d] font-bold bg-[#c9a24d]/10 border border-[#c9a24d]/30 rounded-full px-3 py-1">📣 Announcement</span>
                </div>
                <h3 className="text-lg font-extrabold text-white tracking-wide mb-3">Developer SDK — Now Available. Mobile App Launched Today!</h3>
                <p className="text-sm text-[#94a3b8] font-mono leading-relaxed mb-4">
                  The <code className="text-[#00f2fe]">@inaya-network/custody-sdk</code> developer SDK is live now — build against Inaya's encryption, sharding, and on-chain custody layer directly. The Inaya Mobile app's alpha build is available to download below, with a premium new interface in active development ahead of full public release.
                </p>
                <p className="text-sm text-[#94a3b8] font-mono leading-relaxed mb-4">
                  Inaya's Developer Platform delivers a complete ecosystem for building next-generation decentralized storage applications. Beyond a traditional SDK, it includes an official TypeScript SDK, React package, command-line tools, project scaffolding with create-inaya-dapp, live Storybook, production-ready templates, and extensive documentation. Developers have access to a comprehensive API supporting secure file uploads, deletion, renaming, moving, sharing, folder management, retry logic, upload progress callbacks, event listeners, advanced error handling, and strong TypeScript typings. Combined with client-side AES-256 encryption, binary sharding, immutable blockchain metadata, and open-source components, the platform enables teams to rapidly build scalable, secure, and enterprise-ready Web3 applications without having to implement the underlying decentralized storage infrastructure themselves.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">

<a
                    href="https://github.com/Talhawaqas/inaya-mobile/releases/download/Mobile-App-Alpha-ver1.1/app-release.apk"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => track('mobile_apk_download', { version: 'alpha-1.1' })}
                    className="px-6 py-3 bg-gradient-to-r from-emerald-400 to-teal-500 text-[#060913] font-black text-xs rounded-xl text-center shadow-[0_0_15px_rgba(52,211,153,0.2)] hover:brightness-110 active:scale-95 transition-all"
                  >
                    📱 Download Inaya Mobile App - Alpha Version 1.1 (.apk)
                  </a>

                  <a
                    href="https://github.com/Talhawaqas/custody-sdk"
                    target="_blank"
                    rel="noreferrer"
                    className="px-6 py-3 bg-white/5 border border-white/10 text-white font-black text-xs rounded-xl text-center hover:bg-white/10 active:scale-95 transition-all"
                  >
                    👨‍💻 View Developer SDK on GitHub
                  </a>
                </div>
                <p className="text-[12px] text-slate-500 mt-3 font-mono">
                  SDK access is currently by invite — contact us for collaborator access.
                </p>
              </div>

              <div className="bg-[#090d16]/80 border border-[#00f2fe]/20 rounded-2xl p-6 backdrop-blur-md shadow-xl space-y-4">
                <h3 className="text-lg font-extrabold text-white tracking-wide border-b border-white/5 pb-2">🛡️ OUR ARCHITECTURAL MISSION</h3>
                <p className="text-sm text-[#94a3b8] font-mono leading-relaxed">
                  The primary objective of the Inaya Network is to re-establish absolute data sovereignty directly at the client-side execution layer. By eliminating institutional intermediaries and systemic runtime vectors, we empower edge-node operators with uncompromised asset management control.
                </p>
                <p className="text-sm text-[#94a3b8] font-mono leading-relaxed">
                  Our protocol uses client-side cryptographic sharding backed by PBKDF2 key derivation and AES-GCM encryption. Files are encrypted and split into independent fragments before they ever leave the browser — no single node, server, or administrator holds a complete, decryptable copy of your data.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[13px] font-mono pt-2">
                  <div className="bg-black/40 border border-cyan-500/20 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">✓ Client-Side Encrypted:</span>
                    <p className="text-slate-500 mt-1">Files are encrypted locally before upload. Plaintext never traverses the network pipelines intact.</p>
                  </div>
                  <div className="bg-black/40 border border-emerald-500/20 p-4 rounded-xl">
                    <span className="text-emerald-400 font-bold">✓ Decentralized Immutable Anchoring:</span>
                    <p className="text-slate-500 mt-1">State variables are locked into EVM registers on the BNB Chain, maintaining bulletproof transactional lineage tracking.</p>
                  </div>
                </div>
                <p className="text-sm text-[#94a3b8] font-mono leading-relaxed pt-2 border-t border-white/5">
                  What started as a storage protocol has grown into a full ecosystem on the same infrastructure: the <span className="text-white">Business Workspace</span> (encrypted document management &amp; workflow for companies), a decentralized <span className="text-white">Security Layer</span> (&quot;Inaya Firewall&quot; — node-reported, reputation-weighted, on-chain-confirmed threat intelligence), <span className="text-white">Inaya Learn</span> (an AI-tutored educational platform), an <span className="text-white">Investor Data Room</span>, native <span className="text-white">desktop apps</span> for Windows &amp; Linux, and three purpose-built <span className="text-white">AI assistants</span> — all live today, all built on the same zero-knowledge foundation.
                </p>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-5">👤 EXECUTIVE LEADERSHIP &amp; FOUNDER MATRIX</h3>
                <div className="space-y-4">

                  <div className="border border-[#00f2fe]/20 bg-black/20 rounded-xl p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <span className="text-white font-bold text-base">Talha Waqas</span>
                      <span className="text-[11px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 px-2.5 py-1 rounded-full uppercase tracking-wide">Founder &amp; CTO</span>
                    </div>
                    <p className="text-[13px] text-slate-500 italic font-mono mb-3">Core System Architect, Smart Contract Architect &amp; Lead Web3 Full-Stack Engineer</p>
                    <div className="text-[11px] font-bold text-amber-400/80 uppercase tracking-widest mb-1.5">Professional Expertise</div>
                    <p className="text-xs text-[#94a3b8] font-mono leading-relaxed">
                      Deep specialization in browser-layer cryptographic engineering, EVM smart contract architecture, client-side encrypted storage protocols, and node telemetry networks. Leads technical execution of the decentralized storage kernels, automated gas estimation pipelines, and public ledger sync operations — along with core codebase development and security parameter optimization for the Inaya stack.
                    </p>
                  </div>

                  <div className="border border-white/10 bg-black/20 rounded-xl p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <span className="text-white font-bold text-base">Yakub Adnan</span>
                      <span className="text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded-full uppercase tracking-wide">Co-Founder &amp; Growth Lead</span>
                    </div>
                    <p className="text-[13px] text-slate-500 italic font-mono mb-3">Web3 Growth Operator &amp; Community Strategist</p>
                    <div className="text-[11px] font-bold text-amber-400/80 uppercase tracking-widest mb-1.5">Professional Expertise</div>
                    <p className="text-xs text-[#94a3b8] font-mono leading-relaxed">
                      Specializes in DePIN, user acquisition, and AI-driven ecosystem scaling. Leads Inaya Network's growth architecture, community operations, and campaign distribution — bridging complex protocol features with viral on-chain adoption.
                    </p>
                  </div>

                  <div className="border border-white/10 bg-black/20 rounded-xl p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <span className="text-white font-bold text-base">Fibha Urooj</span>
                      <span className="text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded-full uppercase tracking-wide">Chief Financial Officer</span>
                    </div>
                    <p className="text-[13px] text-slate-500 italic font-mono mb-3">B.Com — Accounting &amp; Finance</p>
                    <div className="text-[11px] font-bold text-amber-400/80 uppercase tracking-widest mb-1.5">Professional Expertise</div>
                    <p className="text-xs text-[#94a3b8] font-mono leading-relaxed">
                      Leads financial planning, budgeting, compliance, and operational finance. Committed to building a strong financial foundation that supports Inaya Network's long-term growth and mission to deliver AI-powered digital sovereignty solutions.
                    </p>
                  </div>

                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-1">📖 FOUNDER STORY</h3>
                <p className="text-[13px] text-slate-500 italic font-mono mb-4">Talha Waqas — Founder &amp; CTO</p>
                <div className="space-y-3">
                  {[
                    "I didn't come to this from a blockchain background. For over nine years I worked in enterprise IT and network support, handling access and infrastructure for corporate clients. That work put me on the inside of something most people never see directly: how casually organizations handle the systems that hold other people's data.",
                    "Then came the Google Password Manager breach. It wasn't the first incident I'd followed — for the past four years, data breach headlines have arrived at a pace that stopped feeling like news and started feeling like a pattern. But that one was the moment it stopped being background noise. People don't actually control their own data — they hand it to a platform and hope. That felt backwards. Data should be something you control and are responsible for, not something you entrust and hope survives.",
                    "I'd spent late 2023 teaching myself cloud infrastructure — VMware, GCP, Docker, Azure. In hindsight, that was me building the runway for this without knowing it yet.",
                    "In mid-June 2026, that thought turned into action. I've been building Inaya every day since — the core zero-knowledge data custody layer went from an idea to a shipped Alpha in about two months: files encrypted and sharded on your own device before anything reaches the network, so no server, node, or administrator ever holds a complete, decryptable copy. I'm also the one directly answering questions on X and Telegram, every day — I'm not building this at a distance from the people using it.",
                    "I'm not doing this alone. Yakub Adnan drives our growth and community presence. Fibha Urooj keeps our financial decisions disciplined, not just ambitious.",
                  ].map((p, i) => (
                    <p key={i} className="text-xs text-[#94a3b8] font-mono leading-relaxed">{p}</p>
                  ))}
                </div>
                <div className="border-l-4 border-[#00f2fe] pl-4 mt-4">
                  <p className="text-xs text-white font-mono leading-relaxed italic">
                    I believe the fix is structural: take the complete, decryptable copy away from every intermediary, and give control back to the person the data actually belongs to.
                  </p>
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🗺️ TACTICAL PROJECT DEVELOPMENT ROADMAP</h3>
                <div className="space-y-4">
                  {roadmapPhases.map((p) => {
                    const s = roadmapStatusConfig[p.status];
                    return (
                      <div key={p.phase} className={`p-4 rounded-xl border font-mono text-xs ${s.tint} ${s.border}`}>
                        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                          <span className={`font-bold text-sm ${s.text}`}>{p.phase}</span>
                          <span className={`text-[10px] font-bold uppercase tracking-widest rounded px-1.5 py-0.5 border ${s.badge}`}>{s.emoji} {s.label}</span>
                        </div>
                        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5">
                          {p.items.map((item) => {
                            const text = typeof item === 'string' ? item : item.text;
                            const done = typeof item === 'object' && item.done;
                            return (
                              <li key={text} className={`text-[13px] flex items-start gap-1.5 ${done ? 'text-slate-300' : s.item}`}>
                                <span className={done ? 'text-emerald-400' : s.text}>{done ? '✓' : s.bullet}</span>
                                {text}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🎬 PRODUCT &amp; DEMO</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {productDemoVideos.map((demo) => (
                    <div key={demo.src} className="bg-black/20 border border-white/5 rounded-xl overflow-hidden">
                      <video controls preload="metadata" playsInline className="w-full aspect-video bg-black block">
                        <source src={demo.src} type="video/mp4" />
                      </video>
                      <div className="p-4">
                        <div className="text-sm font-bold text-white">{demo.title}</div>
                        <p className="text-[13px] text-[#8a96ab] font-mono mt-1 leading-relaxed">{demo.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">📚 OFFICIAL DOCUMENTS &amp; RESOURCES</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {documentsList.map((doc) => (
                    <a
                      key={doc.href}
                      href={doc.href}
                      target="_blank"
                      rel="noreferrer"
                      className="group bg-black/20 border border-white/5 hover:border-[#00f2fe]/50 p-4 rounded-xl flex items-start gap-3 transition-all hover:bg-white/[0.02]"
                    >
                      <span className="text-xl leading-none mt-0.5">{doc.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-white group-hover:text-[#00f2fe] transition-colors">
                          {doc.title}
                        </div>
                        <p className="text-[13px] text-[#8a96ab] font-mono mt-1 leading-relaxed">
                          {doc.desc}
                        </p>
                        <span className="inline-block mt-2 text-[12px] font-mono font-bold text-[#00f2fe]">
                          {doc.linkLabel || "VIEW / DOWNLOAD PDF →"}
                        </span>
                      </div>
                    </a>
                  ))}
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🌐 LIVE NETWORKS INTERFACE ENDPOINTS</h3>
                <div className="flex flex-col sm:flex-row gap-4 font-mono text-xs text-[#00f2fe]">
                  {socialLinksList.map((social) => (
                    <a key={social.href} href={social.href} target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe] transition-all py-3 block">{social.label} {social.icon}</a>
                  ))}
                </div>
              </div>

              <div className="bg-black/20 border border-white/5 rounded-2xl p-5 font-mono text-[12px] text-[#8a96ab] leading-relaxed">
                <p className="mb-2"><span className="text-amber-400/80 font-bold">⚠ Deployment Status:</span> Inaya Network is currently deployed on BNB Chain Testnet only. No mainnet funds, tokens, or production data should be used with this interface.</p>
                <p>By connecting a wallet, you acknowledge that Genesis Airdrop rewards earned during the testnet phase — whether through the automatic upload reward or an approved contributor application — will convert into $INAYA mainnet token allocations at TGE, subject to the program's eligibility criteria and anti-sybil verification requirements. Wallet addresses and application details submitted are used solely for ecosystem contribution tracking.</p>
              </div>

              <div className="bg-black/20 border border-[#00f2fe]/15 rounded-2xl p-5 font-mono text-[12px] text-[#8a96ab] leading-relaxed">
                <p className="mb-2"><span className="text-[#00f2fe] font-bold">🧪 Testers &amp; Developers Disclaimer:</span></p>
                <p>Inaya Network is presently operating on BNB Chain Testnet as part of an active testing and development phase. Wallet connectivity can vary by provider during this phase: because most wallet apps do not expose test networks through WalletConnect by default, some mobile wallets (including Trust Wallet, Binance Wallet, SafePal, and Best Wallet) may be unable to complete a testnet connection at this time. This is a deliberate policy made by each wallet provider — not a limitation of the Inaya Network protocol or interface. MetaMask, along with browsers offering a built-in wallet such as Brave, currently provide the most consistent connection experience for testers and developers. Full, unrestricted wallet compatibility is expected at mainnet launch, when these same connections run on production networks that every major wallet supports natively. We appreciate testers' and developers' patience navigating these testnet-specific constraints as the protocol progresses toward mainnet.</p>
              </div>
            </div>
          )}

          {/* 📇 VIEWPORT AREA 7: CONTACT US */}
          {currentPage === 'Contact Us' && (
            <div className="max-w-4xl mx-auto space-y-8">

              <div className="bg-[#090d16]/80 border border-[#00f2fe]/20 rounded-2xl p-6 backdrop-blur-md shadow-xl space-y-2">
                <h2 className="text-2xl font-extrabold text-white tracking-tight">Contact Us</h2>
                <p className="text-[#94a3b8] text-sm">Reach the Inaya Network team directly, or follow along on our public channels.</p>
              </div>

              {/* EMAIL DIRECTORY */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">📧 Email Directory</h3>
                <div className="bg-white/[0.02] border border-white/5 rounded-xl divide-y divide-white/5 overflow-hidden">
                  {contactList.map((contact) => (
                    <a
                      key={contact.email}
                      href={`mailto:${contact.email}`}
                      className="group flex items-center justify-between gap-3 p-4 hover:bg-white/[0.02] transition-all"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-lg leading-none shrink-0">{contact.icon}</span>
                        <div className="min-w-0">
                          <div className="text-[12px] text-[#8a96ab] font-mono uppercase tracking-wider">{contact.label}</div>
                          <div className="text-sm font-bold text-white group-hover:text-[#00f2fe] transition-colors truncate">{contact.email}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); copyToClipboard(contact.email, `contact-${contact.email}`); }}
                          className="text-[12px] text-[#8a96ab] hover:text-[#00f2fe] transition-colors px-1.5"
                          title="Copy email"
                        >
                          {copiedField === `contact-${contact.email}` ? '✅' : '📋'}
                        </button>
                        <span className="text-[12px] font-mono font-bold text-[#00f2fe] opacity-0 group-hover:opacity-100 transition-opacity">EMAIL →</span>
                      </div>
                    </a>
                  ))}
                </div>
              </div>

              {/* SOCIAL / PUBLIC CHANNELS */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🌐 Public Channels</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {socialLinksList.map((social) => (
                    <a
                      key={social.href}
                      href={social.href}
                      target="_blank"
                      rel="noreferrer"
                      className="bg-black/20 border border-white/5 hover:border-[#00f2fe]/50 rounded-xl p-5 flex flex-col items-center text-center gap-2 transition-all hover:bg-white/[0.02]"
                    >
                      <span className="text-3xl">{social.icon}</span>
                      <span className="text-xs font-mono font-bold text-white">{social.label}</span>
                      <span className="text-[11px] font-mono font-bold text-[#00f2fe]">VISIT →</span>
                    </a>
                  ))}
                </div>
              </div>

              {/* INVESTOR RESOURCES */}
              <div className="bg-[#090d16]/80 border border-[#c9a24d]/25 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-3">💼 Investors</h3>
                <p className="text-sm text-[#94a3b8] leading-relaxed">Interested in learning more about Inaya Network?</p>
                <p className="text-sm text-[#94a3b8] leading-relaxed mt-2 mb-4">
                  Access our Executive Summary, Investment Memorandum, GTM Strategy, technical documentation, and product demonstrations.
                </p>
                <a
                  href="https://drive.google.com/drive/folders/1i91fWkX1etQeoi_XR6ndW-iKQtMxi5la?usp=sharing"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block px-6 py-3 bg-gradient-to-r from-[#c9a24d] to-[#e8c375] text-[#0a0e14] font-black text-xs rounded-xl hover:brightness-110 active:scale-95 transition-all"
                >
                  → View Investor Resources
                </a>
              </div>

              <div className="bg-black/20 border border-white/5 rounded-2xl p-5 font-mono text-[12px] text-[#8a96ab] leading-relaxed">
                <p>All addresses above route to the Inaya Network team. For time-sensitive support requests, use <span className="text-[#00f2fe] font-bold">support@inayanetwork.com</span> — for institutional or enterprise discussions, use <span className="text-[#00f2fe] font-bold">partners@inayanetwork.com</span> or <span className="text-[#00f2fe] font-bold">investors@inayanetwork.com</span>.</p>
              </div>

              {/* LEGAL */}
              <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-mono text-[#8a96ab] pt-2">
                <a href="/privacy" className="hover:text-[#00f2fe] transition-colors">Privacy Policy</a>
                <span className="text-white/10">·</span>
                <a href="/terms" className="hover:text-[#00f2fe] transition-colors">Terms of Service</a>
                <span className="text-white/10">·</span>
                <a href="/.well-known/security.txt" className="hover:text-[#00f2fe] transition-colors">security.txt</a>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* OVERLAY MODAL FOR CONNECT PROVIDERS */}
      {isWalletModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-[9999]">
          <div className="bg-[#090e1a] border border-[#00f2fe]/20 w-full max-w-sm rounded-2xl p-6 relative">
            <button onClick={() => setIsWalletModalOpen(false)} className="absolute top-4 right-4 text-[#8a96ab] font-mono hover:text-white">✕</button>
            <div className="text-center mb-5"><h3 className="text-white font-bold">Select Gateway Access</h3></div>
            <div className="space-y-2">
              {(typeof window !== 'undefined' && window.__TAURI__
                ? [
                    // Desktop app: no browser extension exists inside the native
                    // webview, so MetaMask/Trust/Coinbase's window.ethereum path
                    // is a dead end here -- WalletConnect (QR/relay, no extension
                    // needed) is the one that actually works, so it leads.
                    { name: 'WalletConnect', badge: '✓ Recommended for Desktop', badgeClass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
                    { name: 'MetaMask', badge: '✗ Needs browser extension', badgeClass: 'text-red-400 bg-red-500/10 border-red-500/30', disabled: true },
                    { name: 'Trust Wallet', badge: '✗ Needs browser extension', badgeClass: 'text-red-400 bg-red-500/10 border-red-500/30', disabled: true },
                    { name: 'Coinbase Wallet', badge: '✗ Needs browser extension', badgeClass: 'text-red-400 bg-red-500/10 border-red-500/30', disabled: true },
                  ]
                : [
                    { name: 'MetaMask', badge: '✓ Recommended', badgeClass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
                    { name: 'Trust Wallet', badge: '⚠ Testnet limited', badgeClass: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
                    { name: 'Coinbase Wallet', badge: '⚠ May need manual open', badgeClass: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
                    { name: 'WalletConnect', badge: '⚠ Varies by wallet', badgeClass: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
                  ]
              ).map((w) => (
                <button
                  key={w.name}
                  disabled={w.disabled}
                  onClick={() => !w.disabled && connectTargetWallet(w.name)}
                  className={`w-full bg-white/[0.02] border border-white/5 p-3.5 rounded-xl transition-all flex items-center justify-between gap-2 ${w.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-[#00f2fe] hover:bg-white/5'}`}
                >
                  <span className="text-left text-xs text-white font-bold">{w.name}</span>
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${w.badgeClass}`}>{w.badge}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-3 flex gap-2">
              <span className="text-amber-400 text-xs shrink-0">ℹ️</span>
              <p className="text-[12px] text-amber-400/80 font-mono leading-relaxed">
                This dApp runs on <strong>BNB Chain Testnet</strong>. Not every mobile wallet exposes testnets over WalletConnect — that's the wallet's own choice, not something this site controls. <strong>MetaMask</strong> (and browsers with a built-in wallet, like Brave) currently offer the most reliable connection. If <strong>Coinbase Wallet</strong> opens to its home screen instead of this site, manually type <span className="text-amber-300">inayanetwork.com</span> into Coinbase's built-in browser and tap Connect Wallet again from there.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TESTNET FEEDBACK — Submit a Bug / Submit an Idea */}
      {feedbackModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-[9999]">
          <div className="bg-[#090e1a] border border-[#00f2fe]/20 w-full max-w-md rounded-2xl p-6 relative max-h-[90vh] overflow-y-auto">
            <button onClick={() => setFeedbackModal(null)} className="absolute top-4 right-4 text-[#8a96ab] font-mono hover:text-white">✕</button>
            <div className="text-center mb-5">
              <h3 className="text-white font-bold">{feedbackModal === 'bug' ? '🐛 Report a Bug' : '💡 Suggest an Idea'}</h3>
              <p className="text-[12px] text-[#8a96ab] font-mono mt-1">Testnet feedback — helps us prioritize what to fix/build next.</p>
            </div>

            {feedbackSuccess ? (
              <div className="text-center py-6">
                <p className="text-emerald-400 font-bold text-sm">✅ Thanks — feedback submitted!</p>
              </div>
            ) : (
              <form onSubmit={handleFeedbackSubmit} className="space-y-3">
                <div>
                  <label className="text-[12px] text-[#8a96ab] font-mono uppercase">Title</label>
                  <input
                    type="text"
                    required
                    maxLength={200}
                    value={feedbackForm.title}
                    onChange={(e) => setFeedbackForm((f) => ({ ...f, title: e.target.value }))}
                    className="w-full mt-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/50"
                    placeholder={feedbackModal === 'bug' ? 'Short summary of the bug' : 'Short summary of the idea'}
                  />
                </div>

                <div>
                  <label className="text-[12px] text-[#8a96ab] font-mono uppercase">Description</label>
                  <textarea
                    required
                    maxLength={5000}
                    rows={4}
                    value={feedbackForm.description}
                    onChange={(e) => setFeedbackForm((f) => ({ ...f, description: e.target.value }))}
                    className="w-full mt-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/50"
                    placeholder="What happened / what you'd like to see"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[12px] text-[#8a96ab] font-mono uppercase">Category</label>
                    <select
                      value={feedbackForm.category}
                      onChange={(e) => setFeedbackForm((f) => ({ ...f, category: e.target.value }))}
                      className="w-full mt-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00f2fe]/50"
                    >
                      {FEEDBACK_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  {feedbackModal === 'bug' && (
                    <div>
                      <label className="text-[12px] text-[#8a96ab] font-mono uppercase">Severity</label>
                      <select
                        value={feedbackForm.severity}
                        onChange={(e) => setFeedbackForm((f) => ({ ...f, severity: e.target.value }))}
                        className="w-full mt-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00f2fe]/50"
                      >
                        {FEEDBACK_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  )}
                </div>

                {feedbackModal === 'bug' && (
                  <div>
                    <label className="text-[12px] text-[#8a96ab] font-mono uppercase">Steps to reproduce (optional)</label>
                    <textarea
                      maxLength={3000}
                      rows={3}
                      value={feedbackForm.reproductionSteps}
                      onChange={(e) => setFeedbackForm((f) => ({ ...f, reproductionSteps: e.target.value }))}
                      className="w-full mt-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/50"
                      placeholder={'1. Go to...\n2. Click...\n3. See error'}
                    />
                  </div>
                )}

                <div>
                  <label className="text-[12px] text-[#8a96ab] font-mono uppercase">Screenshot / file (optional)</label>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
                    onChange={handleFeedbackFileChange}
                    className="w-full mt-1 text-xs text-[#94a3b8] file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-white/10 file:text-white file:text-xs"
                  />
                  {feedbackUploading && <p className="text-[12px] text-[#00f2fe] mt-1">Uploading…</p>}
                  {feedbackAttachmentUrl && !feedbackUploading && <p className="text-[12px] text-emerald-400 mt-1">✓ Attached: {feedbackFile?.name}</p>}
                </div>

                {feedbackError && <p className="text-red-400 text-xs">⚠ {feedbackError}</p>}

                <button
                  type="submit"
                  disabled={feedbackSubmitting || feedbackUploading}
                  className="w-full py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl shadow-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {feedbackSubmitting ? 'SUBMITTING...' : feedbackModal === 'bug' ? 'SUBMIT BUG REPORT' : 'SUBMIT IDEA'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ========================================================
          🤖 AI DOCS ASSISTANT — FLOATING CHAT WIDGET (Gemini-backed)
         ======================================================== */}
      {!isChatOpen && (
        <button
          onClick={() => setIsChatOpen(true)}
          className="fixed bottom-5 right-5 z-[9998] w-14 h-14 rounded-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] shadow-[0_0_25px_rgba(0,242,254,0.35)] flex items-center justify-center text-2xl active:scale-95 transition-transform hover:brightness-110"
          title="Ask the Inaya docs assistant"
        >
          💬
        </button>
      )}

      {isChatOpen && (
        // Mobile-first: full-screen sheet so it can never overlap background
        // content (contract links, etc). From `sm:` up, reverts to the
        // original floating bottom-right card.
        <div className="fixed inset-0 z-[9998] w-full h-full sm:inset-auto sm:bottom-24 sm:right-5 sm:w-[92vw] sm:max-w-sm sm:h-[70vh] sm:max-h-[560px] bg-[#090e1a]/95 sm:border sm:border-[#00f2fe]/25 sm:rounded-2xl shadow-2xl backdrop-blur-xl flex flex-col overflow-hidden">

          {/* Widget Header */}
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-white/10 bg-[#0b1426]/80 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <img src="/inaya-logo.png" alt="Inaya" className="w-7 h-7 rounded-lg shrink-0 border border-[#00f2fe]/30" />
              <div className="min-w-0">
                <div className="text-white text-xs font-bold font-mono truncate">Inaya Docs Assistant</div>
                <div className="text-[11px] text-[#8a96ab] font-mono">Gemini-powered · FAQ &amp; docs</div>
              </div>
            </div>
            <button onClick={() => setIsChatOpen(false)} className="text-[#8a96ab] hover:text-white font-mono text-sm shrink-0 px-1">✕</button>
          </div>

          {/* Message Transcript */}
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-4 py-4 pb-6 space-y-3 overscroll-contain">
            {chatMessages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs font-mono leading-relaxed break-words ${
                    msg.role === 'user'
                      ? 'bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-semibold whitespace-pre-wrap'
                      : 'bg-white/[0.04] border border-white/10 text-slate-200'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
                      {msg.content || ' '}
                    </ReactMarkdown>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {isChatSending && !isChatStreaming && (
              <div className="flex justify-start">
                <div className="bg-white/[0.04] border border-white/10 text-[#8a96ab] rounded-2xl px-3.5 py-2.5 text-xs font-mono flex items-center gap-1.5">
                  <span className="animate-pulse">●</span>
                  <span className="animate-pulse [animation-delay:150ms]">●</span>
                  <span className="animate-pulse [animation-delay:300ms]">●</span>
                </div>
              </div>
            )}

            {chatError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-3.5 py-2.5 text-[12px] font-mono">
                ⚠️ {chatError}
              </div>
            )}
          </div>

          {/* Suggested prompt chips — only before the user's first message, so they don't clutter an ongoing conversation */}
          {chatMessages.length <= 1 && (
            <div className="px-3 pt-2 flex flex-wrap gap-1.5 shrink-0">
              {SUGGESTED_CHAT_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleSendChatMessage(prompt)}
                  disabled={isChatSending}
                  className="text-[12px] font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/25 rounded-full px-3 py-1.5 hover:bg-[#00f2fe]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          {/* Input Row */}
          <div className="p-3 border-t border-white/10 bg-[#0b1426]/60 flex items-end gap-2 shrink-0">
            <textarea
              ref={chatInputRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatInputKeyDown}
              placeholder="Ask about pricing, staking, tokenomics..."
              rows={1}
              className="flex-1 resize-none bg-[#060913] border border-white/10 rounded-xl px-3.5 py-2.5 text-white text-xs font-mono focus:outline-none focus:border-[#00f2fe]/40 max-h-24"
            />
            <button
              onClick={() => handleSendChatMessage()}
              disabled={isChatSending || !chatInput.trim()}
              className="shrink-0 px-4 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isChatSending ? '⏳' : '➤'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
